const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { config } = require('../config');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const db = require('../db');
const discord = require('../services/discord');
const { getPartFilename, sleep, formatFileSize } = require('../utils/file');
const { HEADER_LENGTH, createDecipherFromHeaderAsync } = require('../utils/crypto');
const { downloadPartsToFile } = require('../services/partDownloader');
const { perfLogger } = require('../utils/perfLogger');
const { hashPassword, verifyPassword } = require('../utils/password');

const router = express.Router();

// Track active uploads for cancellation support
const activeUploads = new Map(); // fileId -> { cancelled: boolean, partsSent: [] }

/**
 * Cancel an active upload
 */
function cancelUpload(fileId) {
  const upload = activeUploads.get(fileId);
  if (upload) {
    upload.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Check if upload was cancelled
 */
function isUploadCancelled(fileId) {
  const upload = activeUploads.get(fileId);
  return upload?.cancelled === true;
}

/**
 * Register a new active upload
 */
function registerUpload(fileId) {
  activeUploads.set(fileId, { cancelled: false, partsSent: [] });
}

/**
 * Record sent part for potential cleanup
 */
function recordSentPart(fileId, messageId) {
  const upload = activeUploads.get(fileId);
  if (upload) {
    upload.partsSent.push(messageId);
  }
}

/**
 * Get and remove upload tracking data
 */
function finishUpload(fileId) {
  const upload = activeUploads.get(fileId);
  activeUploads.delete(fileId);
  return upload;
}

function ensureFilePasswordIfRequired(req, file) {
  if (!file?.op_password_hash) return;
  const provided = req.headers['x-file-password'] || req.body?.password || req.query?.password;
  if (!provided || !verifyPassword(provided, file.op_password_salt, file.op_password_hash)) {
    throw new ApiError(403, 'Password required or incorrect for this file');
  }
}

/**
 * Cleanup any messages/DB records for a partially completed upload
 */
async function cleanupUploadArtifacts(fileId, { deleteDb = true } = {}) {
  const uploadData = finishUpload(fileId);
  if (uploadData && uploadData.partsSent.length > 0) {
    const uniqueMessages = Array.from(new Set(uploadData.partsSent));
    await discord.deleteMessagesBulk(uniqueMessages);
  }
  if (deleteDb && fileId) {
    db.deleteFile(fileId);
  }
}

// Configure multer for disk storage to avoid buffering giant files in memory
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.chunkSize + 256 * 1024 }, // allow chunk + small overhead
});

/**
 * GET /api/files - List files (root level) and all folders
 * Query params:
 *   - folderId: get files in specific folder (use "null" or omit for root)
 */
router.get('/', asyncHandler(async (req, res) => {
  const { folderId } = req.query;

  // Parse folderId - null means root level
  const parsedFolderId = folderId === undefined || folderId === 'null' || folderId === ''
    ? null
    : parseInt(folderId, 10);

  const files = db.getAllFiles(parsedFolderId, req.user?.id || null, !req.user);
  const folders = db.getAllFolders(req.user?.id || null, !req.user);

  const formattedFiles = files.map(file => ({
    id: file.id,
    name: file.name,
    originalName: file.original_name,
    size: file.size,
    sizeFormatted: formatFileSize(file.size),
    mimeType: file.mime_type,
    totalParts: file.total_parts,
    folderId: file.folder_id,
    sortOrder: file.sort_order,
    createdAt: file.created_at,
    encryptionHeader: file.encryption_header,
    locked: !!file.op_password_hash,
    userId: file.user_id,
    mediaWidth: file.media_width ?? null,
    mediaHeight: file.media_height ?? null,
  }));

  res.json({
    success: true,
    files: formattedFiles,
    folders: folders,
    currentFolderId: parsedFolderId,
  });
}));

/**
 * POST /api/files - Start a client-side encrypted upload
 * Body: { originalName, size, mimeType, totalParts, folderId?, encryptionHeader }
 */
router.post('/', asyncHandler(async (req, res) => {
  const { originalName, size, mimeType, totalParts, folderId = null, encryptionHeader, mediaWidth = null, mediaHeight = null } = req.body || {};

  if (!originalName || !size || !totalParts || !encryptionHeader) {
    throw new ApiError(400, 'originalName, size, totalParts, and encryptionHeader are required');
  }

  const parsedFolderId = folderId === null || folderId === undefined
    ? null
    : parseInt(folderId, 10);

  if (parsedFolderId !== null) {
    const folder = db.getFolderById(parsedFolderId);
    if (!folder) {
      throw new ApiError(404, 'Folder not found');
    }
    if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
      throw new ApiError(403, 'Forbidden');
    }
  }

  const fileId = db.insertFile(
    originalName,
    originalName,
    size,
    mimeType || null,
    totalParts,
    { folderId: Number.isNaN(parsedFolderId) ? null : parsedFolderId, encryptionHeader, uploaderIp: req.ip, userId: req.user?.id || null, mediaWidth: mediaWidth ?? null, mediaHeight: mediaHeight ?? null }
  );

  registerUpload(fileId);
  const uploadEntry = activeUploads.get(fileId);
  if (uploadEntry) {
    uploadEntry.totalParts = totalParts;
    uploadEntry.completedParts = 0;
  }

  res.status(201).json({
    success: true,
    fileId,
    totalParts,
    chunkSize: config.upload.chunkSize,
    batchSize: config.upload.batchSize,
    botCount: discord.getBotCount(),
    aggressiveMode: config.upload.aggressiveMode, // For performance testing - max speed immediately
  });
}));

/**
 * POST /api/files/:id/chunks - Receive client-encrypted chunks (batch)
 * Expects multipart/form-data with `metadata` (JSON array) and chunk files in the same order.
 */
router.post('/:id/chunks', memoryUpload.any(), asyncHandler(async (req, res) => {
  const requestStart = Date.now();
  const fileId = parseInt(req.params.id, 10);
  const file = db.getFileById(fileId);
  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  ensureFilePasswordIfRequired(req, file);

  const uploadEntry = activeUploads.get(fileId);
  if (uploadEntry?.cancelled) {
    throw new ApiError(499, 'Upload cancelled');
  }
  if (isUploadCancelled(fileId)) {
    throw new ApiError(499, 'Upload cancelled');
  }
  if (!uploadEntry) {
    throw new ApiError(400, 'No active upload for this file');
  }

  let metadata = [];
  try {
    metadata = JSON.parse(req.body.metadata || '[]');
  } catch {
    throw new ApiError(400, 'Invalid metadata');
  }

  if (!Array.isArray(metadata) || metadata.length !== req.files.length) {
    throw new ApiError(400, 'Metadata and chunk count mismatch');
  }
  if (!req.files || req.files.length === 0) {
    throw new ApiError(400, 'No chunks provided');
  }

  const parseStart = Date.now();
  const chunks = metadata.map((meta, idx) => {
    const partNumber = parseInt(meta.partNumber ?? meta.part_index ?? meta.part, 10);
    if (!partNumber) {
      throw new ApiError(400, 'Each chunk requires partNumber');
    }
    const buffer = req.files[idx]?.buffer;
    if (!buffer) {
      throw new ApiError(400, 'Missing chunk buffer');
    }
    const filename = file.total_parts === 1
      ? file.original_name
      : getPartFilename(file.original_name, partNumber, file.total_parts);
    return {
      buffer,
      filename,
      partIndex: partNumber,
      iv: meta.iv,
      authTag: meta.authTag,
      plainSize: meta.plainSize ?? meta.plain_size ?? null,
    };
  });
  const parseTime = Date.now() - parseStart;

  // Calculate total bytes received
  const totalBytes = chunks.reduce((sum, c) => sum + c.buffer.length, 0);
  const partNumbers = chunks.map(c => c.partIndex);
  perfLogger.logChunksReceived(partNumbers, totalBytes, parseTime);

  // Split into batches for multi-bot sending
  const batches = [];
  let batch = [];
  const batchSize = config.upload.batchSize;
  for (const chunk of chunks) {
    batch.push(chunk);
    if (batch.length >= batchSize) {
      batches.push(batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    batches.push(batch);
  }

  const sendStart = Date.now();
  const results = await discord.sendFileBatchesParallel(batches, perfLogger);
  const discordTime = Date.now() - sendStart;
  const allChunks = batches.flat();

  perfLogger.log('Discord batch complete', {
    discordTimeMs: discordTime,
    speedMBps: discordTime > 0 ? ((totalBytes / 1024 / 1024) / (discordTime / 1000)).toFixed(2) : 0,
    batches: batches.length,
    fileId,
  });

  const dbStart = Date.now();
  for (const result of results) {
    const chunkInfo = allChunks.find(c => c.partIndex === result.partIndex);
    if (!chunkInfo) continue;
    db.recordUploadStat(chunkInfo.buffer.length, Math.max(1, Math.round(discordTime / Math.max(allChunks.length, 1))));
    db.insertFilePart(fileId, result.partIndex, result.messageId, result.url, result.size, {
      iv: chunkInfo.iv,
      authTag: chunkInfo.authTag,
      plainSize: chunkInfo.plainSize,
    });
    recordSentPart(fileId, result.messageId);
  }
  const dbTime = Date.now() - dbStart;

  if (uploadEntry) {
    uploadEntry.completedParts = (uploadEntry.completedParts || 0) + results.length;
  }

  const totalTime = Date.now() - requestStart;
  perfLogger.logRequestComplete(totalTime, parseTime, discordTime, dbTime, chunks.length);

  res.json({
    success: true,
    storedParts: results.length,
    completedParts: uploadEntry?.completedParts ?? null,
  });
}));

/**
 * POST /api/files/:id/finish - Finalize upload
 */
router.post('/:id/finish', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const file = db.getFileById(fileId);
  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  ensureFilePasswordIfRequired(req, file);

  finishUpload(fileId);
  res.json({
    success: true,
    file: {
      id: file.id,
      name: file.name,
      originalName: file.original_name,
      size: file.size,
      sizeFormatted: formatFileSize(file.size),
      mimeType: file.mime_type,
      totalParts: file.total_parts,
      encryptionHeader: file.encryption_header,
    },
  });
}));

/**
 * POST /api/files/:id/cancel - Cancel an active upload
 */
router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const file = db.getFileById(fileId);
  if (file) {
    if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
      throw new ApiError(403, 'Forbidden');
    }
    ensureFilePasswordIfRequired(req, file);
  }

  if (cancelUpload(fileId)) {
    console.log(`[Upload] Cancel requested for file ${fileId}`);
    await cleanupUploadArtifacts(fileId, { deleteDb: true });
    res.json({ success: true, message: 'Upload cancelled' });
  } else {
    throw new ApiError(404, 'No active upload found with this ID');
  }
}));
/**
 * GET /api/files/:id - Get file info
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const file = db.getFileById(parseInt(req.params.id, 10));
  
  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }

  // Verify file password if locked
  ensureFilePasswordIfRequired(req, file);

  res.json({
    success: true,
    file: {
      id: file.id,
      name: file.name,
      originalName: file.original_name,
      size: file.size,
      sizeFormatted: formatFileSize(file.size),
      mimeType: file.mime_type,
      totalParts: file.total_parts,
      createdAt: file.created_at,
      encryptionHeader: file.encryption_header,
      locked: !!file.op_password_hash,
      parts: file.parts.map(p => ({
        partNumber: p.part_number,
        url: p.discord_url,
        size: p.size,
        plainSize: p.plain_size,
        iv: p.iv,
        authTag: p.auth_tag,
      })),
    },
  });
}));

/**
 * GET /api/files/:id/parts/:partNumber - Stream an encrypted part from Discord
 */
router.get('/:id/parts/:partNumber', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const partNumber = parseInt(req.params.partNumber, 10);
  const file = db.getFileById(fileId);
  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  ensureFilePasswordIfRequired(req, file);
  const part = file.parts.find(p => p.part_number === partNumber);
  if (!part) {
    throw new ApiError(404, 'Part not found');
  }

  const response = await fetch(part.discord_url);
  if (!response.ok) {
    throw new ApiError(502, `Failed to fetch part ${partNumber} from Discord`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}));

// Track active downloads for progress reporting
const activeDownloads = new Map(); // fileId -> { completedParts, totalParts, bytesDownloaded, totalBytes, startTime, cancelled, abortController }

/**
 * GET /api/files/:id/download/progress - SSE endpoint for download progress
 */
router.get('/:id/download/progress', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const file = db.getFileById(fileId);
  if (file) {
    if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
      throw new ApiError(403, 'Forbidden');
    }
    ensureFilePasswordIfRequired(req, file);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const buildProgressPayload = (progress) => {
    const elapsed = Date.now() - progress.startTime;
    const speedBps = elapsed > 0 ? Math.round((progress.bytesDownloaded / elapsed) * 1000) : 0;
    const percent = progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesDownloaded / progress.totalBytes) * 100))
      : Math.round((progress.completedParts / Math.max(progress.totalParts, 1)) * 100);
    const remainingBytes = Math.max(progress.totalBytes - progress.bytesDownloaded, 0);
    const etaFromSpeed = speedBps > 0 ? Math.round((remainingBytes / speedBps) * 1000) : null;
    const perPartMs = progress.completedParts > 0 ? elapsed / progress.completedParts : 0;
    const remainingMs = (progress.totalParts - progress.completedParts) * perPartMs;
    const etaMs = etaFromSpeed !== null ? etaFromSpeed : Math.round(remainingMs);

    progress.speedBps = speedBps;
    progress.percent = percent;
    progress.etaMs = etaMs;

    return {
      completedParts: progress.completedParts,
      totalParts: progress.totalParts,
      percent,
      etaMs,
      status: progress.status,
      speedBps,
      bytesDownloaded: progress.bytesDownloaded,
      totalBytes: progress.totalBytes,
    };
  };

  const sendProgress = () => {
    const progress = activeDownloads.get(fileId);
    if (progress) {
      const payload = buildProgressPayload(progress);

      res.write(`data: ${JSON.stringify({
        type: 'progress',
        ...payload,
      })}\n\n`);
    }
  };

  // Send initial state
  sendProgress();

  // Poll for updates
  const interval = setInterval(sendProgress, 500);

  req.on('close', () => {
    clearInterval(interval);
  });

  // Wait for download to complete
  const checkComplete = setInterval(() => {
    const progress = activeDownloads.get(fileId);
    if (!progress || progress.status === 'complete' || progress.status === 'error' || progress.status === 'cancelled') {
      clearInterval(checkComplete);
      clearInterval(interval);
      if (progress) {
        const payload = buildProgressPayload(progress);
        res.write(`data: ${JSON.stringify({ type: progress.status, ...payload })}\n\n`);
      }
      res.end();
    }
  }, 200);
}));

/**
 * POST /api/files/:id/download/cancel - Cancel an active download
 */
router.post('/:id/download/cancel', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const file = db.getFileById(fileId);
  if (file) {
    if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
      throw new ApiError(403, 'Forbidden');
    }
    ensureFilePasswordIfRequired(req, file);
  }
  const progress = activeDownloads.get(fileId);

  if (progress && progress.status === 'downloading') {
    progress.cancelled = true;
    progress.status = 'cancelled';
    if (progress.abortController) {
      progress.abortController.abort();
    }
    console.log(`[Download] Cancel requested for file ${fileId}`);
    res.json({ success: true, message: 'Download cancellation requested' });
  } else {
    res.json({ success: false, message: 'No active download found' });
  }
}));

/**
 * GET /api/files/:id/download - Download a file (memory efficient)
 */
router.get('/:id/download', asyncHandler(async (req, res) => {
  const file = db.getFileById(parseInt(req.params.id, 10));

  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  ensureFilePasswordIfRequired(req, file);
  if (!config.encryption.key) {
    throw new ApiError(500, 'Server-side download is disabled. Use client-side download.');
  }

  await fs.promises.mkdir(config.upload.tempDir, { recursive: true });
  const tempFile = path.join(
    config.upload.tempDir,
    'download-' + file.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.enc'
  );

  const cleanupTemp = async () => {
    try {
      await fs.promises.unlink(tempFile);
    } catch {
      // ignore
    }
  };

  const totalEncryptedSize = file.parts.reduce((sum, p) => sum + p.size, 0);

  // Create abort controller for cancellation
  const abortController = new AbortController();

  // Register download for progress tracking
  activeDownloads.set(file.id, {
    completedParts: 0,
    totalParts: file.parts.length,
    totalBytes: totalEncryptedSize,
    bytesDownloaded: 0,
    startTime: Date.now(),
    status: 'downloading',
    cancelled: false,
    abortController,
  });

  // Handle client disconnect - cancel download
  req.on('close', () => {
    const progress = activeDownloads.get(file.id);
    if (progress && progress.status === 'downloading') {
      progress.cancelled = true;
      progress.status = 'cancelled';
      abortController.abort();
    }
  });

  let fileHandle = null;

  try {
    const concurrency = config.download.concurrency;
    const chunkSize = config.upload.chunkSize;
    console.log(`[Download ${file.original_name}] Starting parallel download of ${file.parts.length} parts (concurrency: ${concurrency})`);
    const startTime = Date.now();

    // Open file for writing with random access
    fileHandle = await fs.promises.open(tempFile, 'w');

    // Pre-allocate file to avoid fragmentation (optional, improves performance)
    await fileHandle.truncate(totalEncryptedSize);

    // Download all parts directly to file
    await downloadPartsToFile(
      file.parts,
      fileHandle,
      chunkSize,
      concurrency,
      (completed, total, bytesDownloaded) => {
        const progress = activeDownloads.get(file.id);
        if (progress) {
          progress.completedParts = completed;
          if (typeof bytesDownloaded === 'number') {
            progress.bytesDownloaded = bytesDownloaded;
          }
        }
      },
      abortController.signal
    );

    const progressAfterDownload = activeDownloads.get(file.id);
    if (progressAfterDownload) {
      progressAfterDownload.bytesDownloaded = progressAfterDownload.totalBytes;
    }

    await fileHandle.close();
    fileHandle = null;

    const downloadTime = Date.now() - startTime;
    console.log(`[Download ${file.original_name}] Downloaded ${file.parts.length} parts in ${downloadTime}ms`);

    // Update status
    const progress = activeDownloads.get(file.id);
    if (progress) {
      progress.status = 'decrypting';
    }

    // Read header and create decipher (async version uses key cache)
    const headerBuffer = Buffer.alloc(HEADER_LENGTH);
    const headerHandle = await fs.promises.open(tempFile, 'r');
    await headerHandle.read(headerBuffer, 0, HEADER_LENGTH, 0);
    await headerHandle.close();

    const decipher = await createDecipherFromHeaderAsync(headerBuffer, config.encryption.key);
    const encryptedStream = fs.createReadStream(tempFile, { start: HEADER_LENGTH });

    res.setHeader('Content-Disposition', 'attachment; filename="' + file.original_name + '"');
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);

    // Mark as complete before streaming
    const progressFinal = activeDownloads.get(file.id);
    if (progressFinal) {
      progressFinal.status = 'complete';
    }

    await pipeline(encryptedStream, decipher, res);

    const totalTime = Date.now() - startTime;
    console.log(`[Download ${file.original_name}] Complete in ${totalTime}ms`);
  } catch (error) {
    const progress = activeDownloads.get(file.id);
    if (progress) {
      // Check if this was a cancellation
      if (progress.cancelled || error.message === 'Download cancelled') {
        progress.status = 'cancelled';
        console.log(`[Download ${file.original_name}] Cancelled by user`);
        if (!res.headersSent) {
          res.status(499).end(); // Client Closed Request
        }
        return;
      }
      progress.status = 'error';
      progress.error = error.message;
    }
    throw error;
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
    await cleanupTemp();
    // Clean up progress after a delay
    setTimeout(() => activeDownloads.delete(file.id), 5000);
  }
}));

/**
 * PATCH /api/files/reorder - Reorder files within a folder
 * Body: { folderId: number|null, orderedIds: number[] }
 */
router.patch('/reorder', asyncHandler(async (req, res) => {
  const { folderId, orderedIds } = req.body;

  if (!Array.isArray(orderedIds)) {
    throw new ApiError(400, 'orderedIds must be an array');
  }

  // Parse folderId - null means root level
  const parsedFolderId = folderId === undefined || folderId === null || folderId === 'null'
    ? null
    : parseInt(folderId, 10);

  if (parsedFolderId !== null) {
    const folder = db.getFolderById(parsedFolderId);
    if (!folder) {
      throw new ApiError(404, 'Folder not found');
    }
    if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
      throw new ApiError(403, 'Forbidden');
    }
  }

  const accessibleIds = new Set(
    db.getAllFiles(parsedFolderId, req.user?.id || null, !req.user).map(f => f.id)
  );
  const invalid = orderedIds.some(id => !accessibleIds.has(id));
  if (invalid) {
    throw new ApiError(403, 'Cannot reorder files you do not own');
  }

  db.reorderFiles(parsedFolderId, orderedIds);
  const files = db.getAllFiles(parsedFolderId, req.user?.id || null, !req.user);

  const formattedFiles = files.map(file => ({
    id: file.id,
    name: file.name,
    originalName: file.original_name,
    size: file.size,
    sizeFormatted: formatFileSize(file.size),
    folderId: file.folder_id,
    sortOrder: file.sort_order,
    locked: !!file.op_password_hash,
  }));

  res.json({ success: true, files: formattedFiles });
}));

/**
 * PATCH /api/files/:id/password - Remove password (cannot set after upload)
 * Body: { currentPassword: string }
 */
router.patch('/:id/password', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const { currentPassword, newPassword } = req.body || {};
  const file = db.getFileById(fileId);
  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }

  // No password yet: allow set only if uploader IP matches
  if (!file.op_password_hash) {
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length === 0) {
      throw new ApiError(400, 'New password is required to set lock');
    }
    if (!file.uploader_ip || file.uploader_ip !== req.ip) {
      throw new ApiError(403, 'Only the uploader can lock this file (IP mismatch)');
    }
    const hashed = hashPassword(newPassword);
    db.updateFile(fileId, { op_password_hash: hashed.hash, op_password_salt: hashed.salt });
    return res.json({ success: true, message: 'Password set' });
  }

  // Password exists: allow removal with current password
  if (newPassword) {
    throw new ApiError(400, 'Changing password after upload is not allowed');
  }
  if (!currentPassword || !verifyPassword(currentPassword, file.op_password_salt, file.op_password_hash)) {
    throw new ApiError(403, 'Invalid password');
  }

  db.updateFile(fileId, { op_password_hash: null, op_password_salt: null });
  res.json({ success: true, message: 'Password removed' });
}));

/**
 * PATCH /api/files/:id - Update file (move to folder, rename)
 * Body: { folderId?: number|null, originalName?: string }
 */
router.patch('/:id', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const { folderId, originalName } = req.body;

  const file = db.getFileById(fileId);
  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  ensureFilePasswordIfRequired(req, file);

  // Handle folder change
  if (folderId !== undefined) {
    const parsedFolderId = folderId === null || folderId === 'null' ? null : parseInt(folderId, 10);

    // Verify folder exists if not null
    if (parsedFolderId !== null) {
      const folder = db.getFolderById(parsedFolderId);
      if (!folder) {
        throw new ApiError(404, 'Target folder not found');
      }
      if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
        throw new ApiError(403, 'Forbidden');
      }
      if (folder.user_id && file.user_id && folder.user_id !== file.user_id) {
        throw new ApiError(403, 'Cannot move file to a different owner folder');
      }
    }

    db.moveFileToFolder(fileId, parsedFolderId);
  }

  // Handle rename
  if (originalName && typeof originalName === 'string' && originalName.trim().length > 0) {
    db.updateFile(fileId, { original_name: originalName.trim() });
  }

  const updatedFile = db.getFileById(fileId);
  res.json({
    success: true,
    file: {
      id: updatedFile.id,
      name: updatedFile.name,
      originalName: updatedFile.original_name,
      size: updatedFile.size,
      sizeFormatted: formatFileSize(updatedFile.size),
      folderId: updatedFile.folder_id,
      sortOrder: updatedFile.sort_order,
    },
  });
}));

/**
 * DELETE /api/files/:id - Delete a file
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const existing = db.getFileById(fileId);
  if (existing) {
    if (existing.user_id && (!req.user || req.user.id !== existing.user_id)) {
      throw new ApiError(403, 'Forbidden');
    }
    ensureFilePasswordIfRequired(req, existing);
  }
  const file = db.deleteFile(fileId);
  
  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  
  // Try to delete Discord messages (best effort)
  const messageIds = (file.parts || [])
    .map(part => part.message_id)
    .filter(Boolean);
  if (messageIds.length > 0) {
    const uniqueIds = Array.from(new Set(messageIds));
    await discord.deleteMessagesBulk(uniqueIds);
  }
  
  res.json({ success: true, message: 'File deleted' });
}));

module.exports = router;
