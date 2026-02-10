const { DiscordriveDatabase } = require('@discordrive/core');

/** @type {DiscordriveDatabase | null} */
let coreDb = null;

function initDatabase(dbPath) {
  // Core creates files, folders, shares, file_parts, upload_stats tables + indexes
  coreDb = new DiscordriveDatabase(dbPath);

  // Backend-specific tables & migrations on the shared SQLite connection
  const db = coreDb.getDb();

  db.exec(`
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

    CREATE TABLE IF NOT EXISTS gallery_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      last_sync_at DATETIME DEFAULT NULL,
      sync_token TEXT DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // ==================== MIGRATIONS ====================
  // These handle existing databases that may be missing newer columns.

  // Files table migrations
  const fileColumns = db.prepare("PRAGMA table_info(files)").all().map(c => c.name);
  if (!fileColumns.includes('folder_id')) {
    db.exec('ALTER TABLE files ADD COLUMN folder_id INTEGER DEFAULT NULL');
  }
  if (!fileColumns.includes('sort_order')) {
    db.exec('ALTER TABLE files ADD COLUMN sort_order INTEGER DEFAULT 0');
    db.exec('UPDATE files SET sort_order = id WHERE sort_order = 0');
  }
  if (!fileColumns.includes('encryption_header')) {
    db.exec('ALTER TABLE files ADD COLUMN encryption_header TEXT DEFAULT NULL');
  }
  if (!fileColumns.includes('op_password_hash')) {
    db.exec('ALTER TABLE files ADD COLUMN op_password_hash TEXT DEFAULT NULL');
  }
  if (!fileColumns.includes('op_password_salt')) {
    db.exec('ALTER TABLE files ADD COLUMN op_password_salt TEXT DEFAULT NULL');
  }
  if (!fileColumns.includes('uploader_ip')) {
    db.exec('ALTER TABLE files ADD COLUMN uploader_ip TEXT DEFAULT NULL');
  }
  if (!fileColumns.includes('user_id')) {
    db.exec('ALTER TABLE files ADD COLUMN user_id INTEGER DEFAULT NULL');
  }
  if (!fileColumns.includes('media_width')) {
    db.exec('ALTER TABLE files ADD COLUMN media_width INTEGER DEFAULT NULL');
  }
  if (!fileColumns.includes('media_height')) {
    db.exec('ALTER TABLE files ADD COLUMN media_height INTEGER DEFAULT NULL');
  }
  if (!fileColumns.includes('thumbnail_discord_url')) {
    db.exec('ALTER TABLE files ADD COLUMN thumbnail_discord_url TEXT DEFAULT NULL');
  }
  if (!fileColumns.includes('thumbnail_message_id')) {
    db.exec('ALTER TABLE files ADD COLUMN thumbnail_message_id TEXT DEFAULT NULL');
  }
  if (!fileColumns.includes('thumbnail_iv')) {
    db.exec('ALTER TABLE files ADD COLUMN thumbnail_iv TEXT DEFAULT NULL');
  }
  if (!fileColumns.includes('thumbnail_auth_tag')) {
    db.exec('ALTER TABLE files ADD COLUMN thumbnail_auth_tag TEXT DEFAULT NULL');
  }
  if (!fileColumns.includes('thumbnail_size')) {
    db.exec('ALTER TABLE files ADD COLUMN thumbnail_size INTEGER DEFAULT NULL');
  }

  // Folders table migrations
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

  // File parts table migrations
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

  // Users table migrations
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

  // Shares table migrations
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

function getCoreDb() {
  if (!coreDb) throw new Error('Database not initialized');
  return coreDb;
}

function getDb() {
  return getCoreDb().getDb();
}

// ==================== CORE OPERATIONS (delegated to @discordrive/core) ====================

// File operations
function insertFile(name, originalName, size, mimeType, totalParts = 1, options = {}) {
  return getCoreDb().insertFile(name, originalName, size, mimeType, totalParts, options);
}

function insertFilePart(fileId, partNumber, messageId, discordUrl, size, extra = {}) {
  return getCoreDb().insertFilePart(fileId, partNumber, messageId, discordUrl, size, extra);
}

function getAllFiles(folderId = null, userId = null, includeUnowned = false) {
  return getCoreDb().getAllFiles(folderId, userId, includeUnowned);
}

function getFileById(id) {
  return getCoreDb().getFileById(id);
}

function getFileByName(name) {
  return getCoreDb().getFileByName(name);
}

function deleteFile(id) {
  return getCoreDb().deleteFile(id);
}

function updateFile(id, updates) {
  return getCoreDb().updateFile(id, updates);
}

function moveFileToFolder(fileId, folderId) {
  return getCoreDb().moveFileToFolder(fileId, folderId);
}

function reorderFiles(folderId, orderedIds) {
  return getCoreDb().reorderFiles(folderId, orderedIds);
}

function getFilesInFolder(folderId, userId = null, includeUnowned = false) {
  return getAllFiles(folderId, userId, includeUnowned);
}

// Folder operations
function getAllFolders(userId = null, includeUnowned = false) {
  return getCoreDb().getAllFolders(userId, includeUnowned);
}

function getFolderById(id) {
  return getCoreDb().getFolderById(id);
}

function createFolder(name, options = {}) {
  return getCoreDb().createFolder(name, options);
}

function updateFolder(id, updates) {
  return getCoreDb().updateFolder(id, updates);
}

function deleteFolder(id) {
  return getCoreDb().deleteFolder(id);
}

function reorderFolders(orderedIds) {
  return getCoreDb().reorderFolders(orderedIds);
}

// Share operations
function createShare(fileId, folderId, options = {}) {
  return getCoreDb().createShare(fileId, folderId, options);
}

function getShareByToken(token) {
  return getCoreDb().getShareByToken(token);
}

function getSharesForFile(fileId) {
  return getCoreDb().getSharesForFile(fileId);
}

function getSharesForFolder(folderId) {
  return getCoreDb().getSharesForFolder(folderId);
}

function getAllShares() {
  return getCoreDb().getAllShares();
}

function deleteShare(id) {
  return getCoreDb().deleteShare(id);
}

function deleteShareByToken(token) {
  return getCoreDb().deleteShareByToken(token);
}

function incrementShareAccessCount(token) {
  return getCoreDb().incrementShareAccessCount(token);
}

// Stats
function recordUploadStat(chunkSize, durationMs) {
  return getCoreDb().recordUploadStat(chunkSize, durationMs);
}

function getAverageUploadSpeed() {
  return getCoreDb().getAverageUploadSpeed();
}

function getStorageStats() {
  return getCoreDb().getStorageStats();
}

// Thumbnails
function updateFileThumbnail(fileId, thumbnailData) {
  return getCoreDb().updateFileThumbnail(fileId, thumbnailData);
}

function getFileThumbnail(fileId) {
  return getCoreDb().getFileThumbnail(fileId);
}

function clearFileThumbnail(fileId) {
  return getCoreDb().clearFileThumbnail(fileId);
}

function closeDatabase() {
  if (coreDb) {
    coreDb.close();
    coreDb = null;
  }
}

// ==================== APP-SPECIFIC OPERATIONS (raw SQL on shared DB) ====================

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

// Bug report operations
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
    title, description, stepsToReproduce, expectedBehavior, actualBehavior,
    browserInfo, systemInfo, errorLogs, userId, reporterIp
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

// Gallery sync operations
function getMediaFiles({ userId = null, since = null, limit = 100, folderId = undefined }) {
  const params = {};
  let conditions = [`(f.mime_type LIKE 'image/%' OR f.mime_type LIKE 'video/%')`];

  if (userId !== null) {
    conditions.push('f.user_id = @userId');
    params.userId = userId;
  }

  if (since) {
    conditions.push('f.created_at > @since');
    params.since = since;
  }

  if (folderId !== undefined) {
    if (folderId === null) {
      conditions.push('f.folder_id IS NULL');
    } else {
      conditions.push('f.folder_id = @folderId');
      params.folderId = folderId;
    }
  }

  params.limit = limit;

  const query = `
    SELECT
      f.id, f.name, f.original_name, f.size, f.mime_type, f.total_parts,
      f.folder_id, f.encryption_header, f.created_at, f.media_width, f.media_height,
      f.thumbnail_discord_url, f.thumbnail_iv, f.thumbnail_auth_tag, f.thumbnail_size,
      fo.name as folder_name,
      (SELECT fp.discord_url FROM file_parts fp WHERE fp.file_id = f.id AND fp.part_number = 1) as first_part_url,
      (SELECT fp.iv FROM file_parts fp WHERE fp.file_id = f.id AND fp.part_number = 1) as first_part_iv,
      (SELECT fp.auth_tag FROM file_parts fp WHERE fp.file_id = f.id AND fp.part_number = 1) as first_part_auth_tag
    FROM files f
    LEFT JOIN folders fo ON f.folder_id = fo.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.created_at DESC
    LIMIT @limit
  `;

  return getDb().prepare(query).all(params);
}

function getMediaFileById(fileId) {
  return getDb().prepare(`
    SELECT
      f.id, f.name, f.original_name, f.size, f.mime_type, f.total_parts,
      f.folder_id, f.encryption_header, f.created_at, f.media_width, f.media_height,
      (SELECT fp.discord_url FROM file_parts fp WHERE fp.file_id = f.id AND fp.part_number = 1) as first_part_url,
      (SELECT fp.iv FROM file_parts fp WHERE fp.file_id = f.id AND fp.part_number = 1) as first_part_iv,
      (SELECT fp.auth_tag FROM file_parts fp WHERE fp.file_id = f.id AND fp.part_number = 1) as first_part_auth_tag
    FROM files f
    WHERE f.id = ? AND (f.mime_type LIKE 'image/%' OR f.mime_type LIKE 'video/%')
  `).get(fileId) || null;
}

function getGallerySyncState(userId) {
  return getDb().prepare('SELECT * FROM gallery_sync WHERE user_id = ?').get(userId) || null;
}

function updateGallerySyncState(userId, syncToken) {
  return getDb().prepare(`
    INSERT INTO gallery_sync (user_id, last_sync_at, sync_token)
    VALUES (?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_sync_at = CURRENT_TIMESTAMP,
      sync_token = excluded.sync_token
  `).run(userId, syncToken);
}

function getMediaStats(userId = null) {
  const params = {};
  let conditions = [`(mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')`];

  if (userId !== null) {
    conditions.push('user_id = @userId');
    params.userId = userId;
  }

  const result = getDb().prepare(`
    SELECT
      COUNT(*) as total_media,
      COALESCE(SUM(size), 0) as total_size,
      COUNT(CASE WHEN mime_type LIKE 'image/%' THEN 1 END) as image_count,
      COUNT(CASE WHEN mime_type LIKE 'video/%' THEN 1 END) as video_count
    FROM files
    WHERE ${conditions.join(' AND ')}
  `).get(params);

  return {
    totalMedia: result.total_media,
    totalSize: result.total_size,
    imageCount: result.image_count,
    videoCount: result.video_count,
  };
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
  // Gallery sync operations
  getMediaFiles,
  getMediaFileById,
  getGallerySyncState,
  updateGallerySyncState,
  getMediaStats,
  // Thumbnail operations
  updateFileThumbnail,
  getFileThumbnail,
  clearFileThumbnail,
};
