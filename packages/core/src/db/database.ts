import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import type {
  FileRecord,
  FilePartRecord,
  FolderRecord,
  ShareRecord,
  InsertFileOptions,
  InsertFilePartExtra,
  CreateShareOptions,
  CreateFolderOptions,
} from '../types.js';

export class DiscordriveDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
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
        media_width INTEGER DEFAULT NULL,
        media_height INTEGER DEFAULT NULL,
        thumbnail_discord_url TEXT DEFAULT NULL,
        thumbnail_message_id TEXT DEFAULT NULL,
        thumbnail_iv TEXT DEFAULT NULL,
        thumbnail_auth_tag TEXT DEFAULT NULL,
        thumbnail_size INTEGER DEFAULT NULL,
        FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
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
        channel_id TEXT NOT NULL,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
        UNIQUE(file_id, part_number)
      );

      CREATE TABLE IF NOT EXISTS upload_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_size INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

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
        url_key TEXT DEFAULT NULL,
        media_width INTEGER DEFAULT NULL,
        media_height INTEGER DEFAULT NULL,
        allow_embed INTEGER DEFAULT 1,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
        CHECK ((file_id IS NOT NULL AND folder_id IS NULL) OR (file_id IS NULL AND folder_id IS NOT NULL))
      );

      CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
      CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
      CREATE INDEX IF NOT EXISTS idx_files_sort_order ON files(folder_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_files_mime_type ON files(mime_type);
      CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
      CREATE INDEX IF NOT EXISTS idx_files_user_media ON files(user_id, mime_type);
      CREATE INDEX IF NOT EXISTS idx_file_parts_file_id ON file_parts(file_id);
      CREATE INDEX IF NOT EXISTS idx_folders_sort_order ON folders(sort_order);
      CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
      CREATE INDEX IF NOT EXISTS idx_shares_file_id ON shares(file_id);
      CREATE INDEX IF NOT EXISTS idx_shares_folder_id ON shares(folder_id);
    `);

    // Migration: recreate file_parts with channel_id NOT NULL (deletes old data)
    try {
      const result = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM pragma_table_info('file_parts') WHERE name='channel_id'"
      ).get() as { cnt: number };

      if (result.cnt === 0) {
        console.log('[Migration] Dropping old file_parts table (no channel_id) — recreating with NOT NULL constraint');
        this.db.exec('DROP TABLE IF EXISTS file_parts');
        // Recreate table with channel_id NOT NULL
        this.db.exec(`
          CREATE TABLE file_parts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id INTEGER NOT NULL,
            part_number INTEGER NOT NULL,
            message_id TEXT NOT NULL,
            discord_url TEXT NOT NULL,
            size INTEGER NOT NULL,
            plain_size INTEGER DEFAULT NULL,
            iv TEXT DEFAULT NULL,
            auth_tag TEXT DEFAULT NULL,
            channel_id TEXT NOT NULL,
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
            UNIQUE(file_id, part_number)
          );
          CREATE INDEX IF NOT EXISTS idx_file_parts_file_id ON file_parts(file_id);
        `);
      }
    } catch (err) {
      console.error('[Migration] Error checking file_parts schema:', err);
    }
  }

  // ==================== FILE OPERATIONS ====================

  insertFile(
    name: string,
    originalName: string,
    size: number,
    mimeType: string | null,
    totalParts: number = 1,
    options: InsertFileOptions = {},
  ): number {
    const {
      folderId = null,
      encryptionHeader = null,
      opPasswordHash = null,
      opPasswordSalt = null,
      uploaderIp = null,
      userId = null,
      mediaWidth = null,
      mediaHeight = null,
    } = options;

    const stmt = this.db.prepare(`
      INSERT INTO files (name, original_name, size, mime_type, total_parts, folder_id, encryption_header, op_password_hash, op_password_salt, uploader_ip, user_id, media_width, media_height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      name,
      originalName,
      size,
      mimeType,
      totalParts,
      folderId,
      encryptionHeader,
      opPasswordHash,
      opPasswordSalt,
      uploaderIp,
      userId,
      mediaWidth,
      mediaHeight,
    );
    return Number(result.lastInsertRowid);
  }

  insertFilePart(
    fileId: number,
    partNumber: number,
    messageId: string,
    discordUrl: string,
    size: number,
    extra: InsertFilePartExtra = {},
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO file_parts (file_id, part_number, message_id, discord_url, size, plain_size, iv, auth_tag, channel_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      fileId,
      partNumber,
      messageId,
      discordUrl,
      size,
      extra.plainSize ?? null,
      extra.iv ?? null,
      extra.authTag ?? null,
      extra.channelId ?? null,
    );
  }

  getAllFiles(
    folderId?: number | null,
    userId?: number | null,
    includeUnowned: boolean = false,
  ): FileRecord[] {
    const ownsClause = (() => {
      if (userId != null) {
        return includeUnowned
          ? '(f.user_id = @userId OR f.user_id IS NULL)'
          : 'f.user_id = @userId';
      }
      return 'f.user_id IS NULL';
    })();

    if (folderId === undefined || folderId === null) {
      // Get files without folder (root level)
      return this.db.prepare(`
        SELECT f.*,
               GROUP_CONCAT(fp.discord_url, '|') as urls,
               GROUP_CONCAT(fp.message_id, '|') as message_ids
        FROM files f
        LEFT JOIN file_parts fp ON f.id = fp.file_id
        WHERE f.folder_id IS NULL
          AND ${ownsClause}
        GROUP BY f.id
        ORDER BY f.sort_order ASC, f.created_at DESC
      `).all({ userId }) as FileRecord[];
    } else {
      // Get files in specific folder
      return this.db.prepare(`
        SELECT f.*,
               GROUP_CONCAT(fp.discord_url, '|') as urls,
               GROUP_CONCAT(fp.message_id, '|') as message_ids
        FROM files f
        LEFT JOIN file_parts fp ON f.id = fp.file_id
        WHERE f.folder_id = @folderId
          AND ${ownsClause}
        GROUP BY f.id
        ORDER BY f.sort_order ASC, f.created_at DESC
      `).all({ folderId, userId }) as FileRecord[];
    }
  }

  getFilesPaginated(
    folderId?: number | null,
    userId?: number | null,
    includeUnowned: boolean = false,
    limit: number = 50,
    offset: number = 0,
    search?: string,
  ): FileRecord[] {
    const ownsClause = (() => {
      if (userId != null) {
        return includeUnowned
          ? '(f.user_id = @userId OR f.user_id IS NULL)'
          : 'f.user_id = @userId';
      }
      return 'f.user_id IS NULL';
    })();

    if (search) {
      return this.db.prepare(`
        SELECT f.*,
               GROUP_CONCAT(fp.discord_url, '|') as urls,
               GROUP_CONCAT(fp.message_id, '|') as message_ids
        FROM files f
        LEFT JOIN file_parts fp ON f.id = fp.file_id
        WHERE f.name LIKE @search
          AND ${ownsClause}
        GROUP BY f.id
        ORDER BY f.created_at DESC
        LIMIT @limit OFFSET @offset
      `).all({ userId, search: `%${search}%`, limit, offset }) as FileRecord[];
    }

    if (folderId === undefined || folderId === null) {
      return this.db.prepare(`
        SELECT f.*,
               GROUP_CONCAT(fp.discord_url, '|') as urls,
               GROUP_CONCAT(fp.message_id, '|') as message_ids
        FROM files f
        LEFT JOIN file_parts fp ON f.id = fp.file_id
        WHERE f.folder_id IS NULL
          AND ${ownsClause}
        GROUP BY f.id
        ORDER BY f.sort_order ASC, f.created_at DESC
        LIMIT @limit OFFSET @offset
      `).all({ userId, limit, offset }) as FileRecord[];
    } else {
      return this.db.prepare(`
        SELECT f.*,
               GROUP_CONCAT(fp.discord_url, '|') as urls,
               GROUP_CONCAT(fp.message_id, '|') as message_ids
        FROM files f
        LEFT JOIN file_parts fp ON f.id = fp.file_id
        WHERE f.folder_id = @folderId
          AND ${ownsClause}
        GROUP BY f.id
        ORDER BY f.sort_order ASC, f.created_at DESC
        LIMIT @limit OFFSET @offset
      `).all({ folderId, userId, limit, offset }) as FileRecord[];
    }
  }

  countFiles(
    folderId?: number | null,
    userId?: number | null,
    includeUnowned: boolean = false,
    search?: string,
  ): number {
    const ownsClause = (() => {
      if (userId != null) {
        return includeUnowned
          ? '(f.user_id = @userId OR f.user_id IS NULL)'
          : 'f.user_id = @userId';
      }
      return 'f.user_id IS NULL';
    })();

    if (search) {
      const result = this.db.prepare(`
        SELECT COUNT(*) as total FROM files f
        WHERE f.name LIKE @search AND ${ownsClause}
      `).get({ userId, search: `%${search}%` }) as { total: number };
      return result.total;
    }

    if (folderId === undefined || folderId === null) {
      const result = this.db.prepare(`
        SELECT COUNT(*) as total FROM files f
        WHERE f.folder_id IS NULL AND ${ownsClause}
      `).get({ userId }) as { total: number };
      return result.total;
    } else {
      const result = this.db.prepare(`
        SELECT COUNT(*) as total FROM files f
        WHERE f.folder_id = @folderId AND ${ownsClause}
      `).get({ folderId, userId }) as { total: number };
      return result.total;
    }
  }

  getFileById(id: number): FileRecord | null {
    const file = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRecord | undefined;
    if (!file) return null;

    const parts = this.db.prepare(
      'SELECT * FROM file_parts WHERE file_id = ? ORDER BY part_number',
    ).all(id) as FilePartRecord[];

    return { ...file, parts };
  }

  getFileByName(name: string): FileRecord | null {
    const file = this.db.prepare('SELECT * FROM files WHERE name = ?').get(name) as FileRecord | undefined;
    if (!file) return null;

    const parts = this.db.prepare(
      'SELECT * FROM file_parts WHERE file_id = ? ORDER BY part_number',
    ).all(file.id) as FilePartRecord[];

    return { ...file, parts };
  }

  deleteFile(id: number): FileRecord | null {
    const file = this.getFileById(id);
    if (!file) return null;

    this.db.prepare('DELETE FROM file_parts WHERE file_id = ?').run(id);
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);

    return file;
  }

  updateFile(id: number, updates: Record<string, unknown>): FileRecord | null {
    const allowedFields = ['folder_id', 'original_name', 'op_password_hash', 'op_password_salt'];
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (setClauses.length === 0) return this.getFileById(id);

    values.push(id);
    const stmt = this.db.prepare(`UPDATE files SET ${setClauses.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getFileById(id);
  }

  moveFileToFolder(fileId: number, folderId: number | null): FileRecord | null {
    // Get max sort_order in target folder
    const maxOrder = this.db.prepare(
      'SELECT MAX(sort_order) as max FROM files WHERE folder_id IS ?',
    ).get(folderId) as { max: number | null };
    const sortOrder = (maxOrder.max || 0) + 1;

    const stmt = this.db.prepare('UPDATE files SET folder_id = ?, sort_order = ? WHERE id = ?');
    stmt.run(folderId, sortOrder, fileId);
    return this.getFileById(fileId);
  }

  reorderFiles(folderId: number | null, orderedIds: number[]): void {
    const stmt = this.db.prepare('UPDATE files SET sort_order = ? WHERE id = ? AND folder_id IS ?');
    const updateMany = this.db.transaction((ids: number[]) => {
      ids.forEach((id, index) => {
        stmt.run(index, id, folderId);
      });
    });
    updateMany(orderedIds);
  }

  // ==================== FOLDER OPERATIONS ====================

  getAllFolders(userId?: number | null, includeUnowned: boolean = false): FolderRecord[] {
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

    return this.db.prepare(`
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
    `).all({ userId }) as FolderRecord[];
  }

  getFolderById(id: number): FolderRecord | null {
    const folder = this.db.prepare(`
      SELECT f.*,
             (SELECT COUNT(*) FROM files WHERE folder_id = f.id) as file_count
      FROM folders f
      WHERE f.id = ?
    `).get(id) as FolderRecord | undefined;
    return folder || null;
  }

  createFolder(name: string, options: CreateFolderOptions = {}): FolderRecord {
    const { opPasswordHash = null, opPasswordSalt = null, userId = null } = options;
    const maxOrder = this.db.prepare('SELECT MAX(sort_order) as max FROM folders').get() as { max: number | null };
    const sortOrder = (maxOrder.max || 0) + 1;

    const stmt = this.db.prepare(`
      INSERT INTO folders (name, sort_order, op_password_hash, op_password_salt, user_id) VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(name, sortOrder, opPasswordHash, opPasswordSalt, userId);
    return this.getFolderById(Number(result.lastInsertRowid))!;
  }

  updateFolder(id: number, updates: Record<string, unknown>): FolderRecord | null {
    const allowedFields = ['name', 'op_password_hash', 'op_password_salt'];
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (setClauses.length === 0) return this.getFolderById(id);
    values.push(id);
    const stmt = this.db.prepare(`UPDATE folders SET ${setClauses.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getFolderById(id);
  }

  deleteFolder(id: number): FolderRecord | null {
    const folder = this.getFolderById(id);
    if (!folder) return null;

    // CASCADE will delete files in this folder
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return folder;
  }

  reorderFolders(orderedIds: number[]): void {
    const stmt = this.db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?');
    const updateMany = this.db.transaction((ids: number[]) => {
      ids.forEach((id, index) => {
        stmt.run(index, id);
      });
    });
    updateMany(orderedIds);
  }

  // ==================== SHARE OPERATIONS ====================

  createShare(
    fileId: number | null,
    folderId: number | null,
    options: CreateShareOptions = {},
  ): ShareRecord {
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

    const stmt = this.db.prepare(`
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
      allowEmbed ? 1 : 0,
    );
    return this.getShareByToken(token)!;
  }

  getShareByToken(token: string): ShareRecord | null {
    const share = this.db.prepare(`
      SELECT s.*,
             f.original_name as file_name,
             f.size as file_size,
             f.mime_type as file_mime_type,
             fo.name as folder_name
      FROM shares s
      LEFT JOIN files f ON s.file_id = f.id
      LEFT JOIN folders fo ON s.folder_id = fo.id
      WHERE s.token = ?
    `).get(token) as ShareRecord | undefined;
    return share || null;
  }

  getSharesForFile(fileId: number): ShareRecord[] {
    return this.db.prepare(`
      SELECT * FROM shares WHERE file_id = ? ORDER BY created_at DESC
    `).all(fileId) as ShareRecord[];
  }

  getSharesForFolder(folderId: number): ShareRecord[] {
    return this.db.prepare(`
      SELECT * FROM shares WHERE folder_id = ? ORDER BY created_at DESC
    `).all(folderId) as ShareRecord[];
  }

  getAllShares(): ShareRecord[] {
    return this.db.prepare(`
      SELECT s.*,
             f.original_name as file_name,
             f.size as file_size,
             fo.name as folder_name
      FROM shares s
      LEFT JOIN files f ON s.file_id = f.id
      LEFT JOIN folders fo ON s.folder_id = fo.id
      ORDER BY s.created_at DESC
    `).all() as ShareRecord[];
  }

  deleteShare(id: number): boolean {
    const result = this.db.prepare('DELETE FROM shares WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteShareByToken(token: string): boolean {
    const result = this.db.prepare('DELETE FROM shares WHERE token = ?').run(token);
    return result.changes > 0;
  }

  incrementShareAccessCount(token: string): void {
    this.db.prepare('UPDATE shares SET access_count = access_count + 1 WHERE token = ?').run(token);
  }

  // ==================== STATS ====================

  recordUploadStat(chunkSize: number, durationMs: number): void {
    // Insert new stat
    this.db.prepare('INSERT INTO upload_stats (chunk_size, duration_ms) VALUES (?, ?)').run(chunkSize, durationMs);

    // Keep only last 100 rows
    this.db.prepare(`
      DELETE FROM upload_stats WHERE id NOT IN (
        SELECT id FROM upload_stats ORDER BY id DESC LIMIT 100
      )
    `).run();
  }

  getAverageUploadSpeed(): { bytesPerSec: number; avgDurationMs: number; avgChunkSize: number; sampleCount: number } {
    const result = this.db.prepare(`
      SELECT
        AVG(chunk_size * 1000.0 / duration_ms) as avg_bytes_per_sec,
        AVG(duration_ms) as avg_duration_ms,
        AVG(chunk_size) as avg_chunk_size,
        COUNT(*) as sample_count
      FROM upload_stats
      WHERE duration_ms > 0
    `).get() as { avg_bytes_per_sec: number | null; avg_duration_ms: number | null; avg_chunk_size: number | null; sample_count: number };

    return {
      bytesPerSec: result.avg_bytes_per_sec || 0,
      avgDurationMs: result.avg_duration_ms || 0,
      avgChunkSize: result.avg_chunk_size || 0,
      sampleCount: result.sample_count || 0,
    };
  }

  getStorageStats(): { totalSize: number; totalFiles: number } {
    const result = this.db.prepare(`
      SELECT
        COALESCE(SUM(size), 0) as totalSize,
        COUNT(*) as totalFiles
      FROM files
    `).get() as { totalSize: number; totalFiles: number };

    return {
      totalSize: result.totalSize,
      totalFiles: result.totalFiles,
    };
  }

  // ==================== THUMBNAIL OPERATIONS ====================

  updateFileThumbnail(
    fileId: number,
    data: { discordUrl: string; messageId: string; iv: string; authTag: string; size: number },
  ): void {
    this.db.prepare(`
      UPDATE files SET
        thumbnail_discord_url = ?,
        thumbnail_message_id = ?,
        thumbnail_iv = ?,
        thumbnail_auth_tag = ?,
        thumbnail_size = ?
      WHERE id = ?
    `).run(data.discordUrl, data.messageId, data.iv, data.authTag, data.size, fileId);
  }

  getFileThumbnail(
    fileId: number,
  ): { discordUrl: string; messageId: string; iv: string; authTag: string; size: number } | null {
    const result = this.db.prepare(`
      SELECT
        thumbnail_discord_url as discordUrl,
        thumbnail_message_id as messageId,
        thumbnail_iv as iv,
        thumbnail_auth_tag as authTag,
        thumbnail_size as size
      FROM files
      WHERE id = ? AND thumbnail_discord_url IS NOT NULL
    `).get(fileId) as { discordUrl: string; messageId: string; iv: string; authTag: string; size: number } | undefined;
    return result || null;
  }

  clearFileThumbnail(fileId: number): void {
    this.db.prepare(`
      UPDATE files SET
        thumbnail_discord_url = NULL,
        thumbnail_message_id = NULL,
        thumbnail_iv = NULL,
        thumbnail_auth_tag = NULL,
        thumbnail_size = NULL
      WHERE id = ?
    `).run(fileId);
  }

  // ==================== URL CACHE ====================

  /**
   * Bulk update discord_url for file parts (URL cache refresh).
   */
  updatePartUrls(updates: Array<{ id: number; discordUrl: string }>): void {
    const stmt = this.db.prepare('UPDATE file_parts SET discord_url = ? WHERE id = ?');
    const updateAll = this.db.transaction((items: typeof updates) => {
      for (const item of items) {
        stmt.run(item.discordUrl, item.id);
      }
    });
    updateAll(updates);
  }

  // ==================== LIFECYCLE ====================

  close(): void {
    this.db.close();
  }

  getDb(): Database.Database {
    return this.db;
  }
}
