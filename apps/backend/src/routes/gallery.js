const express = require('express');
const crypto = require('crypto');
const { asyncHandler } = require('../middleware/errorHandler');
const db = require('../db');

const router = express.Router();

/**
 * Generate a sync token from file IDs and timestamps
 */
function generateSyncToken(files) {
  if (!files.length) return null;
  const lastFile = files[files.length - 1];
  const data = `${lastFile.id}:${lastFile.created_at}`;
  return Buffer.from(data).toString('base64');
}

/**
 * Parse sync token to get the last synced file info
 */
function parseSyncToken(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [id, createdAt] = decoded.split(':');
    return { id: parseInt(id, 10), createdAt };
  } catch {
    return null;
  }
}

/**
 * GET /api/gallery/media
 * Returns media files (images and videos) for gallery sync
 */
router.get('/media', asyncHandler(async (req, res) => {
  const { since, limit = '100', folderId } = req.query;
  const userId = req.user?.id || null;

  const files = db.getMediaFiles({
    userId,
    since: since || null,
    limit: Math.min(parseInt(limit, 10) || 100, 500),
    folderId: folderId !== undefined ? (folderId === 'null' ? null : parseInt(folderId, 10)) : undefined,
  });

  const syncToken = generateSyncToken(files);
  const hasMore = files.length === parseInt(limit, 10);

  res.json({
    success: true,
    files: files.map(f => ({
      id: f.id,
      name: f.name,
      originalName: f.original_name,
      mimeType: f.mime_type,
      size: f.size,
      totalParts: f.total_parts,
      folderId: f.folder_id,
      folderName: f.folder_name,
      mediaWidth: f.media_width,
      mediaHeight: f.media_height,
      createdAt: f.created_at,
      encryptionHeader: f.encryption_header,
      // First part data for thumbnail generation
      firstPartUrl: f.first_part_url,
      firstPartIv: f.first_part_iv,
      firstPartAuthTag: f.first_part_auth_tag,
      // Thumbnail data (if available)
      thumbnailUrl: f.thumbnail_discord_url || null,
      thumbnailIv: f.thumbnail_iv || null,
      thumbnailAuthTag: f.thumbnail_auth_tag || null,
      thumbnailSize: f.thumbnail_size || null,
    })),
    syncToken,
    hasMore,
    total: files.length,
  });
}));

/**
 * GET /api/gallery/sync
 * Incremental sync endpoint - returns changes since last sync
 */
router.get('/sync', asyncHandler(async (req, res) => {
  const { since, limit = '100' } = req.query;
  const userId = req.user?.id || null;

  // Get files changed since timestamp
  const files = db.getMediaFiles({
    userId,
    since: since || null,
    limit: Math.min(parseInt(limit, 10) || 100, 500),
  });

  const syncToken = generateSyncToken(files);
  const hasMore = files.length === parseInt(limit, 10);

  // Get sync state for this user if authenticated
  let lastSyncAt = null;
  if (userId) {
    const syncState = db.getGallerySyncState(userId);
    lastSyncAt = syncState?.last_sync_at || null;
  }

  res.json({
    success: true,
    files: files.map(f => ({
      id: f.id,
      name: f.name,
      originalName: f.original_name,
      mimeType: f.mime_type,
      size: f.size,
      totalParts: f.total_parts,
      folderId: f.folder_id,
      folderName: f.folder_name,
      mediaWidth: f.media_width,
      mediaHeight: f.media_height,
      createdAt: f.created_at,
      encryptionHeader: f.encryption_header,
      firstPartUrl: f.first_part_url,
      firstPartIv: f.first_part_iv,
      firstPartAuthTag: f.first_part_auth_tag,
      // Thumbnail data (if available)
      thumbnailUrl: f.thumbnail_discord_url || null,
      thumbnailIv: f.thumbnail_iv || null,
      thumbnailAuthTag: f.thumbnail_auth_tag || null,
      thumbnailSize: f.thumbnail_size || null,
    })),
    syncToken,
    hasMore,
    lastSyncAt,
    serverTime: new Date().toISOString(),
  });
}));

/**
 * POST /api/gallery/sync/ack
 * Acknowledge processed sync items
 */
router.post('/sync/ack', asyncHandler(async (req, res) => {
  const { syncToken } = req.body;
  const userId = req.user?.id || null;

  if (!userId) {
    return res.json({
      success: true,
      message: 'Sync acknowledgement stored locally (anonymous user)',
    });
  }

  if (syncToken) {
    db.updateGallerySyncState(userId, syncToken);
  }

  res.json({
    success: true,
    message: 'Sync state updated',
  });
}));

/**
 * GET /api/gallery/media/:id/thumbnail-data
 * Returns encryption metadata needed for client-side thumbnail generation
 */
router.get('/media/:id/thumbnail-data', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const userId = req.user?.id || null;

  const file = db.getMediaFileById(fileId);

  if (!file) {
    return res.status(404).json({
      success: false,
      error: 'Media file not found',
    });
  }

  // Check ownership if user is authenticated
  if (userId !== null && file.user_id !== null && file.user_id !== userId) {
    return res.status(403).json({
      success: false,
      error: 'Access denied',
    });
  }

  res.json({
    success: true,
    data: {
      id: file.id,
      originalName: file.original_name,
      mimeType: file.mime_type,
      size: file.size,
      mediaWidth: file.media_width,
      mediaHeight: file.media_height,
      encryptionHeader: file.encryption_header,
      firstPartUrl: file.first_part_url,
      firstPartIv: file.first_part_iv,
      firstPartAuthTag: file.first_part_auth_tag,
    },
  });
}));

/**
 * GET /api/gallery/stats
 * Returns media statistics for the gallery
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;

  const stats = db.getMediaStats(userId);

  // Get last sync info if authenticated
  let lastSync = null;
  if (userId) {
    const syncState = db.getGallerySyncState(userId);
    lastSync = syncState?.last_sync_at || null;
  }

  res.json({
    success: true,
    stats: {
      totalMedia: stats.totalMedia,
      totalSize: stats.totalSize,
      imageCount: stats.imageCount,
      videoCount: stats.videoCount,
      lastSync,
    },
  });
}));

/**
 * GET /api/gallery/folders
 * Returns folders containing media files
 */
router.get('/folders', asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;

  // Get all folders that the user has access to
  const folders = db.getAllFolders(userId, true);

  // Filter to only include folders with media files
  // and add media count
  const foldersWithMedia = folders.map(folder => {
    const mediaFiles = db.getMediaFiles({
      userId,
      folderId: folder.id,
      limit: 1000,
    });

    return {
      id: folder.id,
      name: folder.name,
      mediaCount: mediaFiles.length,
      createdAt: folder.created_at,
    };
  }).filter(f => f.mediaCount > 0);

  // Also count root-level media
  const rootMedia = db.getMediaFiles({
    userId,
    folderId: null,
    limit: 1000,
  });

  res.json({
    success: true,
    folders: foldersWithMedia,
    rootMediaCount: rootMedia.length,
  });
}));

module.exports = router;
