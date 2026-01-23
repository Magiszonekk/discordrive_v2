import * as SQLite from 'expo-sqlite';
import type { LocalMediaItem, GalleryMediaItem, LocalSyncState } from '@discordrive/shared/types';

let db: SQLite.SQLiteDatabase | null = null;

export async function initDatabase(): Promise<void> {
  db = await SQLite.openDatabaseAsync('gallery.db');

  await db.execAsync(`
    -- Local media index (mirrors server data + local state)
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      total_parts INTEGER DEFAULT 1,
      folder_id INTEGER,
      folder_name TEXT,
      media_width INTEGER,
      media_height INTEGER,
      created_at TEXT NOT NULL,
      encryption_header TEXT,
      first_part_url TEXT,
      first_part_iv TEXT,
      first_part_auth_tag TEXT,
      thumbnail_path TEXT,
      thumbnail_generated_at TEXT,
      thumbnail_uploaded INTEGER DEFAULT 0,
      thumbnail_url TEXT,
      thumbnail_iv TEXT,
      thumbnail_auth_tag TEXT,
      thumbnail_size INTEGER,
      full_cached INTEGER DEFAULT 0,
      full_cache_path TEXT,
      last_viewed_at TEXT,
      favorite INTEGER DEFAULT 0,
      synced_at TEXT NOT NULL
    );

    -- Indexes for efficient queries
    CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder_id);
    CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_favorite ON media(favorite, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_mime ON media(mime_type);

    -- Sync state tracking
    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync_at TEXT,
      sync_token TEXT,
      total_synced INTEGER DEFAULT 0
    );

    -- Initialize sync state if not exists
    INSERT OR IGNORE INTO sync_state (id, total_synced) VALUES (1, 0);
  `);

  // Migration: add thumbnail columns if they don't exist
  try {
    await db.execAsync(`ALTER TABLE media ADD COLUMN thumbnail_uploaded INTEGER DEFAULT 0`);
  } catch { /* Column already exists */ }
  try {
    await db.execAsync(`ALTER TABLE media ADD COLUMN thumbnail_url TEXT`);
  } catch { /* Column already exists */ }
  try {
    await db.execAsync(`ALTER TABLE media ADD COLUMN thumbnail_iv TEXT`);
  } catch { /* Column already exists */ }
  try {
    await db.execAsync(`ALTER TABLE media ADD COLUMN thumbnail_auth_tag TEXT`);
  } catch { /* Column already exists */ }
  try {
    await db.execAsync(`ALTER TABLE media ADD COLUMN thumbnail_size INTEGER`);
  } catch { /* Column already exists */ }
}

export function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// Convert database row to LocalMediaItem
function rowToMediaItem(row: Record<string, unknown>): LocalMediaItem {
  return {
    id: row.id as number,
    name: row.name as string,
    originalName: row.original_name as string,
    mimeType: row.mime_type as string,
    size: row.size as number,
    totalParts: row.total_parts as number,
    folderId: row.folder_id as number | null,
    folderName: row.folder_name as string | null,
    mediaWidth: row.media_width as number | null,
    mediaHeight: row.media_height as number | null,
    createdAt: row.created_at as string,
    encryptionHeader: row.encryption_header as string | null,
    firstPartUrl: row.first_part_url as string | null,
    firstPartIv: row.first_part_iv as string | null,
    firstPartAuthTag: row.first_part_auth_tag as string | null,
    thumbnailPath: row.thumbnail_path as string | null,
    thumbnailGeneratedAt: row.thumbnail_generated_at as string | null,
    thumbnailUploaded: (row.thumbnail_uploaded as number) === 1,
    thumbnailUrl: row.thumbnail_url as string | null,
    thumbnailIv: row.thumbnail_iv as string | null,
    thumbnailAuthTag: row.thumbnail_auth_tag as string | null,
    thumbnailSize: row.thumbnail_size as number | null,
    fullCached: (row.full_cached as number) === 1,
    fullCachePath: row.full_cache_path as string | null,
    lastViewedAt: row.last_viewed_at as string | null,
    favorite: (row.favorite as number) === 1,
    syncedAt: row.synced_at as string,
  };
}

// Get all media, optionally filtered by folder
export async function getAllMedia(folderId?: number | null): Promise<LocalMediaItem[]> {
  const database = getDb();

  let query = 'SELECT * FROM media';
  const params: (number | null)[] = [];

  if (folderId !== undefined) {
    if (folderId === null) {
      query += ' WHERE folder_id IS NULL';
    } else {
      query += ' WHERE folder_id = ?';
      params.push(folderId);
    }
  }

  query += ' ORDER BY created_at DESC';

  const rows = await database.getAllAsync(query, params);
  return rows.map(rowToMediaItem);
}

// Get media by ID
export async function getMediaById(id: number): Promise<LocalMediaItem | null> {
  const database = getDb();
  const row = await database.getFirstAsync('SELECT * FROM media WHERE id = ?', [id]);
  return row ? rowToMediaItem(row as Record<string, unknown>) : null;
}

// Insert or update media item from server
export async function upsertMedia(item: GalleryMediaItem): Promise<void> {
  const database = getDb();
  const now = new Date().toISOString();

  await database.runAsync(
    `INSERT INTO media (
      id, name, original_name, mime_type, size, total_parts,
      folder_id, folder_name, media_width, media_height,
      created_at, encryption_header, first_part_url, first_part_iv,
      first_part_auth_tag, thumbnail_url, thumbnail_iv, thumbnail_auth_tag,
      thumbnail_size, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      original_name = excluded.original_name,
      mime_type = excluded.mime_type,
      size = excluded.size,
      total_parts = excluded.total_parts,
      folder_id = excluded.folder_id,
      folder_name = excluded.folder_name,
      media_width = excluded.media_width,
      media_height = excluded.media_height,
      encryption_header = excluded.encryption_header,
      first_part_url = excluded.first_part_url,
      first_part_iv = excluded.first_part_iv,
      first_part_auth_tag = excluded.first_part_auth_tag,
      thumbnail_url = excluded.thumbnail_url,
      thumbnail_iv = excluded.thumbnail_iv,
      thumbnail_auth_tag = excluded.thumbnail_auth_tag,
      thumbnail_size = excluded.thumbnail_size,
      synced_at = excluded.synced_at`,
    [
      item.id,
      item.name,
      item.originalName,
      item.mimeType,
      item.size,
      item.totalParts,
      item.folderId,
      item.folderName,
      item.mediaWidth,
      item.mediaHeight,
      item.createdAt,
      item.encryptionHeader,
      item.firstPartUrl,
      item.firstPartIv,
      item.firstPartAuthTag,
      item.thumbnailUrl,
      item.thumbnailIv,
      item.thumbnailAuthTag,
      item.thumbnailSize,
      now,
    ]
  );
}

// Update thumbnail path
export async function updateThumbnailPath(id: number, path: string): Promise<void> {
  const database = getDb();
  const now = new Date().toISOString();
  await database.runAsync(
    'UPDATE media SET thumbnail_path = ?, thumbnail_generated_at = ? WHERE id = ?',
    [path, now, id]
  );
}

// Update favorite status
export async function updateFavorite(id: number, favorite: boolean): Promise<void> {
  const database = getDb();
  await database.runAsync('UPDATE media SET favorite = ? WHERE id = ?', [favorite ? 1 : 0, id]);
}

// Update last viewed
export async function updateLastViewed(id: number): Promise<void> {
  const database = getDb();
  const now = new Date().toISOString();
  await database.runAsync('UPDATE media SET last_viewed_at = ? WHERE id = ?', [now, id]);
}

// Delete media by ID
export async function deleteMedia(id: number): Promise<void> {
  const database = getDb();
  await database.runAsync('DELETE FROM media WHERE id = ?', [id]);
}

// Delete all media
export async function deleteAllMedia(): Promise<void> {
  const database = getDb();
  await database.runAsync('DELETE FROM media');
  await database.runAsync('UPDATE sync_state SET last_sync_at = NULL, sync_token = NULL, total_synced = 0 WHERE id = 1');
}

// Get all media IDs (for detecting deletions)
export async function getAllMediaIds(): Promise<number[]> {
  const database = getDb();
  const rows = await database.getAllAsync('SELECT id FROM media');
  return rows.map((row: unknown) => (row as { id: number }).id);
}

// Get sync state
export async function getSyncState(): Promise<LocalSyncState> {
  const database = getDb();
  const row = await database.getFirstAsync('SELECT * FROM sync_state WHERE id = 1');
  if (!row) {
    return { lastSyncAt: null, syncToken: null, totalSynced: 0 };
  }
  const r = row as Record<string, unknown>;
  return {
    lastSyncAt: r.last_sync_at as string | null,
    syncToken: r.sync_token as string | null,
    totalSynced: r.total_synced as number,
  };
}

// Update sync state
export async function updateSyncState(syncToken: string | null, totalSynced: number): Promise<void> {
  const database = getDb();
  const now = new Date().toISOString();
  await database.runAsync(
    'UPDATE sync_state SET last_sync_at = ?, sync_token = ?, total_synced = ? WHERE id = 1',
    [now, syncToken, totalSynced]
  );
}

// Get media without thumbnails (for background generation)
export async function getMediaWithoutThumbnails(limit: number = 50): Promise<LocalMediaItem[]> {
  const database = getDb();
  const rows = await database.getAllAsync(
    'SELECT * FROM media WHERE thumbnail_path IS NULL ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  return rows.map(rowToMediaItem);
}

// Get favorites
export async function getFavorites(): Promise<LocalMediaItem[]> {
  const database = getDb();
  const rows = await database.getAllAsync(
    'SELECT * FROM media WHERE favorite = 1 ORDER BY created_at DESC'
  );
  return rows.map(rowToMediaItem);
}

// Get media count
export async function getMediaCount(): Promise<number> {
  const database = getDb();
  const row = await database.getFirstAsync('SELECT COUNT(*) as count FROM media');
  return (row as { count: number }).count;
}

// Mark thumbnail as uploaded to server
export async function markThumbnailUploaded(
  id: number,
  thumbnailUrl: string,
  thumbnailIv: string,
  thumbnailAuthTag: string,
  thumbnailSize: number
): Promise<void> {
  const database = getDb();
  await database.runAsync(
    `UPDATE media SET
      thumbnail_uploaded = 1,
      thumbnail_url = ?,
      thumbnail_iv = ?,
      thumbnail_auth_tag = ?,
      thumbnail_size = ?
    WHERE id = ?`,
    [thumbnailUrl, thumbnailIv, thumbnailAuthTag, thumbnailSize, id]
  );
}

// Get media items that have local thumbnails but not uploaded to server
export async function getMediaWithUnuploadedThumbnails(limit: number = 50): Promise<LocalMediaItem[]> {
  const database = getDb();
  const rows = await database.getAllAsync(
    `SELECT * FROM media
     WHERE thumbnail_path IS NOT NULL
       AND thumbnail_uploaded = 0
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit]
  );
  return rows.map(rowToMediaItem);
}

// Get media items that have server thumbnails but no local thumbnail
export async function getMediaWithMissingLocalThumbnails(limit: number = 50): Promise<LocalMediaItem[]> {
  const database = getDb();
  const rows = await database.getAllAsync(
    `SELECT * FROM media
     WHERE thumbnail_url IS NOT NULL
       AND thumbnail_path IS NULL
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit]
  );
  return rows.map(rowToMediaItem);
}
