const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let db = null;

function initDatabase(dbPath) {
  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      op_password_hash TEXT DEFAULT NULL,
      op_password_salt TEXT DEFAULT NULL,
      user_id INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT,
      total_parts INTEGER DEFAULT 1,
      folder_id INTEGER DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      encryption_header TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      op_password_hash TEXT DEFAULT NULL,
      op_password_salt TEXT DEFAULT NULL,
      uploader_ip TEXT DEFAULT NULL,
      user_id INTEGER DEFAULT NULL,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      verification_token TEXT,
      reset_token TEXT,
      reset_expires_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS file_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      part_number INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      discord_url TEXT NOT NULL,
      size INTEGER NOT NULL,
      plain_size INTEGER DEFAULT NULL,
      iv TEXT DEFAULT NULL,
      auth_tag TEXT DEFAULT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
      UNIQUE(file_id, part_number)
    );

    CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
    CREATE INDEX IF NOT EXISTS idx_file_parts_file_id ON file_parts(file_id);
    CREATE INDEX IF NOT EXISTS idx_folders_sort_order ON folders(sort_order);

    -- Upload timing stats for ETA calculation (max 1000 rows)
    CREATE TABLE IF NOT EXISTS upload_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_size INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Shares for public file/folder access
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      file_id INTEGER DEFAULT NULL,
      folder_id INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT NULL,
      access_count INTEGER DEFAULT 0,
      encrypted_key TEXT DEFAULT NULL,
      encrypted_key_salt TEXT DEFAULT NULL,
      key_wrap_method TEXT DEFAULT NULL,
      require_password INTEGER DEFAULT 0,
      allow_insecure INTEGER DEFAULT 0,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
      CHECK ((file_id IS NOT NULL AND folder_id IS NULL) OR (file_id IS NULL AND folder_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
    CREATE INDEX IF NOT EXISTS idx_shares_file_id ON shares(file_id);
    CREATE INDEX IF NOT EXISTS idx_shares_folder_id ON shares(folder_id);

    -- Bug reports
    CREATE TABLE IF NOT EXISTS bug_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      steps_to_reproduce TEXT DEFAULT NULL,
      expected_behavior TEXT DEFAULT NULL,
      actual_behavior TEXT DEFAULT NULL,
      browser_info TEXT DEFAULT NULL,
      system_info TEXT DEFAULT NULL,
      error_logs TEXT DEFAULT NULL,
      status TEXT DEFAULT 'open',
      user_id INTEGER DEFAULT NULL,
      reporter_ip TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
    CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON bug_reports(created_at);
  `);

  // Migration: Add folder_id and sort_order to existing files table if missing
  const columns = db.prepare("PRAGMA table_info(files)").all();
  const columnNames = columns.map(c => c.name);

  if (!columnNames.includes('folder_id')) {
    db.exec('ALTER TABLE files ADD COLUMN folder_id INTEGER DEFAULT NULL');
  }
  if (!columnNames.includes('sort_order')) {
    db.exec('ALTER TABLE files ADD COLUMN sort_order INTEGER DEFAULT 0');
    // Set initial sort_order based on id for existing files
    db.exec('UPDATE files SET sort_order = id WHERE sort_order = 0');
  }
  if (!columnNames.includes('encryption_header')) {
    db.exec('ALTER TABLE files ADD COLUMN encryption_header TEXT DEFAULT NULL');
  }
  if (!columnNames.includes('op_password_hash')) {
    db.exec('ALTER TABLE files ADD COLUMN op_password_hash TEXT DEFAULT NULL');
  }
  if (!columnNames.includes('op_password_salt')) {
    db.exec('ALTER TABLE files ADD COLUMN op_password_salt TEXT DEFAULT NULL');
  }
  if (!columnNames.includes('uploader_ip')) {
    db.exec('ALTER TABLE files ADD COLUMN uploader_ip TEXT DEFAULT NULL');
  }
  if (!columnNames.includes('user_id')) {
    db.exec('ALTER TABLE files ADD COLUMN user_id INTEGER DEFAULT NULL');
  }
  if (!columnNames.includes('media_width')) {
    db.exec('ALTER TABLE files ADD COLUMN media_width INTEGER DEFAULT NULL');
  }
  if (!columnNames.includes('media_height')) {
    db.exec('ALTER TABLE files ADD COLUMN media_height INTEGER DEFAULT NULL');
  }

  // Migration: add password columns to folders
  const folderColumns = db.prepare("PRAGMA table_info(folders)").all().map(c => c.name);
  if (!folderColumns.includes('op_password_hash')) {
    db.exec('ALTER TABLE folders ADD COLUMN op_password_hash TEXT DEFAULT NULL');
  }
  if (!folderColumns.includes('op_password_salt')) {
    db.exec('ALTER TABLE folders ADD COLUMN op_password_salt TEXT DEFAULT NULL');
  }
  if (!folderColumns.includes('user_id')) {
    db.exec('ALTER TABLE folders ADD COLUMN user_id INTEGER DEFAULT NULL');
  }

  // Ensure folder-related indexes exist once columns are guaranteed
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
    CREATE INDEX IF NOT EXISTS idx_files_sort_order ON files(folder_id, sort_order);
  `);

  // Migration: add per-chunk encryption metadata columns
  const partColumns = db.prepare("PRAGMA table_info(file_parts)").all().map(c => c.name);
  if (!partColumns.includes('plain_size')) {
    db.exec('ALTER TABLE file_parts ADD COLUMN plain_size INTEGER DEFAULT NULL');
  }
  if (!partColumns.includes('iv')) {
    db.exec('ALTER TABLE file_parts ADD COLUMN iv TEXT DEFAULT NULL');
  }
  if (!partColumns.includes('auth_tag')) {
    db.exec('ALTER TABLE file_parts ADD COLUMN auth_tag TEXT DEFAULT NULL');
  }

  // Migration: add encrypted key storage columns to users table
  const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userColumns.includes('encrypted_key')) {
    db.exec('ALTER TABLE users ADD COLUMN encrypted_key TEXT DEFAULT NULL');
  }
  if (!userColumns.includes('encrypted_key_salt')) {
    db.exec('ALTER TABLE users ADD COLUMN encrypted_key_salt TEXT DEFAULT NULL');
  }
  if (!userColumns.includes('key_sync_enabled')) {
    db.exec('ALTER TABLE users ADD COLUMN key_sync_enabled INTEGER DEFAULT 0');
  }

  // Migration: add wrapped key columns to shares
  const shareColumns = db.prepare("PRAGMA table_info(shares)").all().map(c => c.name);
  if (!shareColumns.includes('encrypted_key')) {
    db.exec('ALTER TABLE shares ADD COLUMN encrypted_key TEXT DEFAULT NULL');
  }
  if (!shareColumns.includes('encrypted_key_salt')) {
    db.exec('ALTER TABLE shares ADD COLUMN encrypted_key_salt TEXT DEFAULT NULL');
  }
  if (!shareColumns.includes('key_wrap_method')) {
    db.exec('ALTER TABLE shares ADD COLUMN key_wrap_method TEXT DEFAULT NULL');
  }
  if (!shareColumns.includes('require_password')) {
    db.exec('ALTER TABLE shares ADD COLUMN require_password INTEGER DEFAULT 0');
  }
  if (!shareColumns.includes('allow_insecure')) {
    db.exec('ALTER TABLE shares ADD COLUMN allow_insecure INTEGER DEFAULT 0');
  }
  if (!shareColumns.includes('url_key')) {
    db.exec('ALTER TABLE shares ADD COLUMN url_key TEXT DEFAULT NULL');
  }
  if (!shareColumns.includes('media_width')) {
    db.exec('ALTER TABLE shares ADD COLUMN media_width INTEGER DEFAULT NULL');
  }
  if (!shareColumns.includes('media_height')) {
    db.exec('ALTER TABLE shares ADD COLUMN media_height INTEGER DEFAULT NULL');
  }
  if (!shareColumns.includes('allow_embed')) {
    db.exec('ALTER TABLE shares ADD COLUMN allow_embed INTEGER DEFAULT 1');
  }

  console.log('Database initialized');
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// File operations
function insertFile(name, originalName, size, mimeType, totalParts = 1, options = {}) {
  const { folderId = null, encryptionHeader = null, opPasswordHash = null, opPasswordSalt = null, uploaderIp = null, userId = null, mediaWidth = null, mediaHeight = null } = options;
  const stmt = getDb().prepare(`
    INSERT INTO files (name, original_name, size, mime_type, total_parts, folder_id, encryption_header, op_password_hash, op_password_salt, uploader_ip, user_id, media_width, media_height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name, originalName, size, mimeType, totalParts, folderId, encryptionHeader, opPasswordHash, opPasswordSalt, uploaderIp, userId, mediaWidth, mediaHeight);
  return result.lastInsertRowid;
}

// User operations
function createUser(username, email, passwordHash, passwordSalt, verificationToken) {
  const stmt = getDb().prepare(`
    INSERT INTO users (username, email, password_hash, password_salt, verification_token)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(username, email, passwordHash, passwordSalt, verificationToken);
  return getUserById(result.lastInsertRowid);
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function getUserByVerificationToken(token) {
  return getDb().prepare('SELECT * FROM users WHERE verification_token = ?').get(token) || null;
}

function getUserByResetToken(token) {
  return getDb().prepare('SELECT * FROM users WHERE reset_token = ?').get(token) || null;
}

function verifyUser(id) {
  getDb().prepare('UPDATE users SET verified = 1, verification_token = NULL WHERE id = ?').run(id);
  return getUserById(id);
}

function setResetToken(userId, token, expiresAt) {
  getDb().prepare('UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?').run(token, expiresAt, userId);
}

function updateUserPassword(userId, hash, salt) {
  getDb().prepare('UPDATE users SET password_hash = ?, password_salt = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?').run(hash, salt, userId);
}

// Encrypted key storage functions
function updateUserEncryptedKey(userId, encryptedKey, salt, enabled) {
  getDb().prepare(`
    UPDATE users SET encrypted_key = ?, encrypted_key_salt = ?, key_sync_enabled = ? WHERE id = ?
  `).run(encryptedKey, salt, enabled ? 1 : 0, userId);
}

function getUserEncryptedKey(userId) {
  return getDb().prepare(`
    SELECT encrypted_key, encrypted_key_salt, key_sync_enabled FROM users WHERE id = ?
  `).get(userId) || null;
}

function clearUserEncryptedKey(userId) {
  getDb().prepare(`
    UPDATE users SET encrypted_key = NULL, encrypted_key_salt = NULL, key_sync_enabled = 0 WHERE id = ?
  `).run(userId);
}

function insertFilePart(fileId, partNumber, messageId, discordUrl, size, extra = {}) {
  const stmt = getDb().prepare(`
    INSERT INTO file_parts (file_id, part_number, message_id, discord_url, size, plain_size, iv, auth_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    fileId,
    partNumber,
    messageId,
    discordUrl,
    size,
    extra.plainSize ?? null,
    extra.iv ?? null,
    extra.authTag ?? null
  );
}

function getAllFiles(folderId = null, userId = null, includeUnowned = false) {
  const ownsClause = (() => {
    if (userId != null) {
      return includeUnowned
        ? '(f.user_id = @userId OR f.user_id IS NULL)'
        : 'f.user_id = @userId';
    }
    return 'f.user_id IS NULL';
  })();

  if (folderId === null) {
    // Get files without folder (root level)
    return getDb().prepare(`
      SELECT f.*,
             GROUP_CONCAT(fp.discord_url, '|') as urls,
             GROUP_CONCAT(fp.message_id, '|') as message_ids
      FROM files f
      LEFT JOIN file_parts fp ON f.id = fp.file_id
      WHERE f.folder_id IS NULL
        AND ${ownsClause}
      GROUP BY f.id
      ORDER BY f.sort_order ASC, f.created_at DESC
    `).all({ userId });
  } else {
    // Get files in specific folder
    return getDb().prepare(`
      SELECT f.*,
             GROUP_CONCAT(fp.discord_url, '|') as urls,
             GROUP_CONCAT(fp.message_id, '|') as message_ids
      FROM files f
      LEFT JOIN file_parts fp ON f.id = fp.file_id
      WHERE f.folder_id = @folderId
        AND ${ownsClause}
      GROUP BY f.id
      ORDER BY f.sort_order ASC, f.created_at DESC
    `).all({ folderId, userId });
  }
}

function getFileById(id) {
  const file = getDb().prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!file) return null;
  
  const parts = getDb().prepare(`
    SELECT * FROM file_parts WHERE file_id = ? ORDER BY part_number
  `).all(id);
  
  return { ...file, parts };
}

function getFileByName(name) {
  const file = getDb().prepare('SELECT * FROM files WHERE name = ?').get(name);
  if (!file) return null;
  
  const parts = getDb().prepare(`
    SELECT * FROM file_parts WHERE file_id = ? ORDER BY part_number
  `).all(file.id);
  
  return { ...file, parts };
}

function deleteFile(id) {
  const file = getFileById(id);
  if (!file) return null;
  
  getDb().prepare('DELETE FROM file_parts WHERE file_id = ?').run(id);
  getDb().prepare('DELETE FROM files WHERE id = ?').run(id);
  
  return file;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// Upload stats for ETA calculation
function recordUploadStat(chunkSize, durationMs) {
  const d = getDb();

  // Insert new stat
  d.prepare('INSERT INTO upload_stats (chunk_size, duration_ms) VALUES (?, ?)').run(chunkSize, durationMs);

  // Keep only last 100 rows
  d.prepare(`
    DELETE FROM upload_stats WHERE id NOT IN (
      SELECT id FROM upload_stats ORDER BY id DESC LIMIT 100
    )
  `).run();
}

function getAverageUploadSpeed() {
  const result = getDb().prepare(`
    SELECT
      AVG(chunk_size * 1000.0 / duration_ms) as avg_bytes_per_sec,
      AVG(duration_ms) as avg_duration_ms,
      AVG(chunk_size) as avg_chunk_size,
      COUNT(*) as sample_count
    FROM upload_stats
    WHERE duration_ms > 0
  `).get();

  return {
    bytesPerSec: result.avg_bytes_per_sec || 0,
    avgDurationMs: result.avg_duration_ms || 0,
    avgChunkSize: result.avg_chunk_size || 0,
    sampleCount: result.sample_count || 0,
  };
}

// ==================== FOLDER OPERATIONS ====================

function getAllFolders(userId = null, includeUnowned = false) {
  const ownsClause = (() => {
    if (userId != null) {
      return includeUnowned
        ? '(f.user_id = @userId OR f.user_id IS NULL)'
        : 'f.user_id = @userId';
    }
    return 'f.user_id IS NULL';
  })();
  const fileCountOwnership = (() => {
    if (userId != null) {
      return includeUnowned
        ? '(f2.user_id = @userId OR f2.user_id IS NULL)'
        : 'f2.user_id = @userId';
    }
    return 'f2.user_id IS NULL';
  })();

  return getDb().prepare(`
    SELECT f.*,
           (
             SELECT COUNT(*)
             FROM files f2
             WHERE f2.folder_id = f.id
               AND ${fileCountOwnership}
           ) as file_count
    FROM folders f
    WHERE ${ownsClause}
    ORDER BY f.sort_order ASC, f.created_at ASC
  `).all({ userId });
}

function getFolderById(id) {
  const folder = getDb().prepare(`
    SELECT f.*,
           (SELECT COUNT(*) FROM files WHERE folder_id = f.id) as file_count
    FROM folders f
    WHERE f.id = ?
  `).get(id);
  return folder || null;
}

function createFolder(name, options = {}) {
  const { opPasswordHash = null, opPasswordSalt = null, userId = null } = options;
  const maxOrder = getDb().prepare('SELECT MAX(sort_order) as max FROM folders').get();
  const sortOrder = (maxOrder.max || 0) + 1;

  const stmt = getDb().prepare(`
    INSERT INTO folders (name, sort_order, op_password_hash, op_password_salt, user_id) VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name, sortOrder, opPasswordHash, opPasswordSalt, userId);
  return getFolderById(result.lastInsertRowid);
}

function updateFolder(id, updates) {
  const allowedFields = ['name', 'op_password_hash', 'op_password_salt'];
  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (setClauses.length === 0) return getFolderById(id);
  values.push(id);
  const stmt = getDb().prepare(`UPDATE folders SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  return getFolderById(id);
}

function deleteFolder(id) {
  const folder = getFolderById(id);
  if (!folder) return null;

  // CASCADE will delete files in this folder
  getDb().prepare('DELETE FROM folders WHERE id = ?').run(id);
  return folder;
}

function reorderFolders(orderedIds) {
  const stmt = getDb().prepare('UPDATE folders SET sort_order = ? WHERE id = ?');
  const updateMany = getDb().transaction((ids) => {
    ids.forEach((id, index) => {
      stmt.run(index, id);
    });
  });
  updateMany(orderedIds);
}

// ==================== FILE UPDATE OPERATIONS ====================

function updateFile(id, updates) {
  const allowedFields = ['folder_id', 'original_name', 'op_password_hash', 'op_password_salt'];
  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return getFileById(id);

  values.push(id);
  const stmt = getDb().prepare(`UPDATE files SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  return getFileById(id);
}

function moveFileToFolder(fileId, folderId) {
  // Get max sort_order in target folder
  const maxOrder = getDb().prepare(
    'SELECT MAX(sort_order) as max FROM files WHERE folder_id IS ?'
  ).get(folderId);
  const sortOrder = (maxOrder.max || 0) + 1;

  const stmt = getDb().prepare('UPDATE files SET folder_id = ?, sort_order = ? WHERE id = ?');
  stmt.run(folderId, sortOrder, fileId);
  return getFileById(fileId);
}

function reorderFiles(folderId, orderedIds) {
  const stmt = getDb().prepare('UPDATE files SET sort_order = ? WHERE id = ? AND folder_id IS ?');
  const updateMany = getDb().transaction((ids) => {
    ids.forEach((id, index) => {
      stmt.run(index, id, folderId);
    });
  });
  updateMany(orderedIds);
}

function getFilesInFolder(folderId, userId = null, includeUnowned = false) {
  return getAllFiles(folderId, userId, includeUnowned);
}

function getStorageStats() {
  const result = getDb().prepare(`
    SELECT
      COALESCE(SUM(size), 0) as totalSize,
      COUNT(*) as totalFiles
    FROM files
  `).get();
  return {
    totalSize: result.totalSize,
    totalFiles: result.totalFiles,
  };
}

// ==================== SHARE OPERATIONS ====================

function createShare(fileId, folderId, options = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const {
    encryptedKey = null,
    encryptedKeySalt = null,
    keyWrapMethod = null,
    requirePassword = false,
    allowInsecure = false,
    urlKey = null,
    mediaWidth = null,
    mediaHeight = null,
    allowEmbed = true,
  } = options;

  const stmt = getDb().prepare(`
    INSERT INTO shares (token, file_id, folder_id, encrypted_key, encrypted_key_salt, key_wrap_method, require_password, allow_insecure, url_key, media_width, media_height, allow_embed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    token,
    fileId || null,
    folderId || null,
    encryptedKey,
    encryptedKeySalt,
    keyWrapMethod,
    requirePassword ? 1 : 0,
    allowInsecure ? 1 : 0,
    urlKey,
    mediaWidth,
    mediaHeight,
    allowEmbed ? 1 : 0
  );
  return getShareByToken(token);
}

function getShareByToken(token) {
  return getDb().prepare(`
    SELECT s.*,
           f.original_name as file_name,
           f.size as file_size,
           f.mime_type as file_mime_type,
           fo.name as folder_name
    FROM shares s
    LEFT JOIN files f ON s.file_id = f.id
    LEFT JOIN folders fo ON s.folder_id = fo.id
    WHERE s.token = ?
  `).get(token);
}

function getSharesForFile(fileId) {
  return getDb().prepare(`
    SELECT * FROM shares WHERE file_id = ? ORDER BY created_at DESC
  `).all(fileId);
}

function getSharesForFolder(folderId) {
  return getDb().prepare(`
    SELECT * FROM shares WHERE folder_id = ? ORDER BY created_at DESC
  `).all(folderId);
}

function getAllShares() {
  return getDb().prepare(`
    SELECT s.*,
           f.original_name as file_name,
           f.size as file_size,
           fo.name as folder_name
    FROM shares s
    LEFT JOIN files f ON s.file_id = f.id
    LEFT JOIN folders fo ON s.folder_id = fo.id
    ORDER BY s.created_at DESC
  `).all();
}

function deleteShare(id) {
  const result = getDb().prepare('DELETE FROM shares WHERE id = ?').run(id);
  return result.changes > 0;
}

function deleteShareByToken(token) {
  const result = getDb().prepare('DELETE FROM shares WHERE token = ?').run(token);
  return result.changes > 0;
}

function incrementShareAccessCount(token) {
  return getDb().prepare('UPDATE shares SET access_count = access_count + 1 WHERE token = ?').run(token);
}

// ==================== BUG REPORT OPERATIONS ====================

function createBugReport(data) {
  const {
    title,
    description,
    stepsToReproduce = null,
    expectedBehavior = null,
    actualBehavior = null,
    browserInfo = null,
    systemInfo = null,
    errorLogs = null,
    userId = null,
    reporterIp = null,
  } = data;

  const stmt = getDb().prepare(`
    INSERT INTO bug_reports (title, description, steps_to_reproduce, expected_behavior, actual_behavior, browser_info, system_info, error_logs, user_id, reporter_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    title,
    description,
    stepsToReproduce,
    expectedBehavior,
    actualBehavior,
    browserInfo,
    systemInfo,
    errorLogs,
    userId,
    reporterIp
  );
  return getBugReportById(result.lastInsertRowid);
}

function getBugReportById(id) {
  return getDb().prepare(`
    SELECT br.*, u.username as reporter_username
    FROM bug_reports br
    LEFT JOIN users u ON br.user_id = u.id
    WHERE br.id = ?
  `).get(id);
}

function getAllBugReports(status = null) {
  if (status) {
    return getDb().prepare(`
      SELECT br.*, u.username as reporter_username
      FROM bug_reports br
      LEFT JOIN users u ON br.user_id = u.id
      WHERE br.status = ?
      ORDER BY br.created_at DESC
    `).all(status);
  }
  return getDb().prepare(`
    SELECT br.*, u.username as reporter_username
    FROM bug_reports br
    LEFT JOIN users u ON br.user_id = u.id
    ORDER BY br.created_at DESC
  `).all();
}

function updateBugReportStatus(id, status) {
  const result = getDb().prepare(`
    UPDATE bug_reports SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(status, id);
  return result.changes > 0 ? getBugReportById(id) : null;
}

function deleteBugReport(id) {
  const result = getDb().prepare('DELETE FROM bug_reports WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = {
  initDatabase,
  getDb,
  insertFile,
  insertFilePart,
  getAllFiles,
  getFileById,
  getFileByName,
  deleteFile,
  closeDatabase,
  recordUploadStat,
  getAverageUploadSpeed,
  // Folder operations
  getAllFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolder,
  reorderFolders,
  // File update operations
  updateFile,
  moveFileToFolder,
  reorderFiles,
  getFilesInFolder,
  // Stats
  getStorageStats,
  // Users
  createUser,
  getUserById,
  getUserByEmail,
  getUserByVerificationToken,
  getUserByResetToken,
  verifyUser,
  setResetToken,
  updateUserPassword,
  // Encrypted key sync
  updateUserEncryptedKey,
  getUserEncryptedKey,
  clearUserEncryptedKey,
  // Share operations
  createShare,
  getShareByToken,
  getSharesForFile,
  getSharesForFolder,
  getAllShares,
  deleteShare,
  deleteShareByToken,
  incrementShareAccessCount,
  // Bug report operations
  createBugReport,
  getBugReportById,
  getAllBugReports,
  updateBugReportStatus,
  deleteBugReport,
};
