const express = require('express');
const archiver = require('archiver');
const { pipeline } = require('stream/promises');
const router = express.Router();
const db = require('../db');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const discord = require('../services/discord');
const { appendFileToArchive } = require('../services/storageAssembler');
const { hashPassword, verifyPassword } = require('../utils/password');

function ensureFolderPasswordIfRequired(req, folder) {
  if (!folder?.op_password_hash) return;
  const provided = req.headers['x-folder-password'] || req.body?.password || req.query?.password;
  if (!provided || !verifyPassword(provided, folder.op_password_salt, folder.op_password_hash)) {
    throw new ApiError(403, 'Password required or incorrect for this folder');
  }
}

function buildContentDisposition(filename) {
  const safeName = filename.replace(/"/g, '');
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// GET /api/folders - List all folders with file counts
router.get('/', asyncHandler(async (req, res) => {
  const folders = db.getAllFolders(req.user?.id || null, !req.user);
  res.json(folders);
}));

// POST /api/folders - Create a new folder
router.post('/', asyncHandler(async (req, res) => {
  const { name, opPassword } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ApiError(400, 'Folder name is required');
  }

  let opPasswordHash = null;
  let opPasswordSalt = null;
  if (opPassword) {
    const hashed = hashPassword(opPassword);
    opPasswordHash = hashed.hash;
    opPasswordSalt = hashed.salt;
  }

  const folder = db.createFolder(name.trim(), { opPasswordHash, opPasswordSalt, userId: req.user?.id || null });
  res.status(201).json(folder);
}));

// GET /api/folders/:id - Get folder by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const folder = db.getFolderById(Number(id));

  if (!folder) {
    throw new ApiError(404, 'Folder not found');
  }
  if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }

  res.json(folder);
}));

// GET /api/folders/:id/contents - Get files in folder
router.get('/:id/contents', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const folder = db.getFolderById(Number(id));

  if (!folder) {
    throw new ApiError(404, 'Folder not found');
  }
  if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }

  // Verify folder password if protected
  ensureFolderPasswordIfRequired(req, folder);

  const files = db.getFilesInFolder(Number(id), req.user?.id || null, !req.user);
  res.json({ folder, files });
}));

// GET /api/folders/:id/download - Download entire folder as ZIP
router.get('/:id/download', asyncHandler(async (req, res) => {
  const folderId = Number(req.params.id);
  const folder = db.getFolderById(folderId);

  if (!folder) {
    throw new ApiError(404, 'Folder not found');
  }
  if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  ensureFolderPasswordIfRequired(req, folder);

  const files = db.getFilesInFolder(folderId, req.user?.id || null, !req.user)
    .map(file => db.getFileById(file.id))
    .filter(Boolean);

  // Block if folder contains password-protected files
  const passwordProtected = files.filter(f => f.op_password_hash);
  if (passwordProtected.length > 0) {
    throw new ApiError(403, `Folder contains ${passwordProtected.length} password-protected file(s). Remove passwords first.`);
  }

  const archive = archiver('zip', { zlib: { level: 9 } });
  let archiveError = null;
  archive.on('warning', err => {
    if (err.code !== 'ENOENT') {
      console.warn('[Folder ZIP warning]', err.message);
    }
  });
  archive.on('error', err => {
    console.error('[Folder ZIP error]', err);
    archiveError = err;
  });

  const zipName = `${folder.name}.zip`;
  res.setHeader('Content-Disposition', buildContentDisposition(zipName));
  res.setHeader('Content-Type', 'application/zip');

  const archivePipeline = pipeline(archive, res);

  for (const file of files) {
    await appendFileToArchive(file, archive, { prefix: `folder-${folderId}` });
  }

  if (archiveError) {
    throw new ApiError(500, 'Archive creation failed: ' + archiveError.message);
  }

  await archive.finalize();
  await archivePipeline;
}));

// PATCH /api/folders/:id - Update folder name
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  const folder = db.getFolderById(Number(id));
  if (!folder) {
    throw new ApiError(404, 'Folder not found');
  }
  if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  ensureFolderPasswordIfRequired(req, folder);

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ApiError(400, 'Folder name is required');
  }

  const updated = db.updateFolder(Number(id), { name: name.trim() });
  res.json(updated);
}));

// PATCH /api/folders/:id/password - remove password (cannot set after creation)
router.patch('/:id/password', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { currentPassword, newPassword } = req.body || {};
  const folder = db.getFolderById(Number(id));
  if (!folder) {
    throw new ApiError(404, 'Folder not found');
  }

  if (!folder.op_password_hash) {
    if (newPassword) {
      throw new ApiError(400, 'Cannot set password after creation');
    }
    return res.json({ success: true, message: 'No password set' });
  }

  if (newPassword) {
    throw new ApiError(400, 'Changing password after creation is not allowed');
  }
  if (!currentPassword || !verifyPassword(currentPassword, folder.op_password_salt, folder.op_password_hash)) {
    throw new ApiError(403, 'Invalid password');
  }

  db.updateFolder(Number(id), { op_password_hash: null, op_password_salt: null });
  res.json({ success: true, message: 'Password removed' });
}));

// DELETE /api/folders/:id - Delete folder
// Query param: ?force=true to delete even if folder contains files
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { force } = req.query;

  const folder = db.getFolderById(Number(id));
  if (!folder) {
    throw new ApiError(404, 'Folder not found');
  }
  if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  ensureFolderPasswordIfRequired(req, folder);

  // Check if folder has files
  if (folder.file_count > 0 && force !== 'true') {
    throw new ApiError(400, `Folder contains ${folder.file_count} file(s). Use ?force=true to delete anyway.`);
  }

  // If force=true and folder has files, delete messages from Discord first
  if (folder.file_count > 0) {
    const files = db.getFilesInFolder(Number(id), req.user?.id || null, !req.user);

    // Block if folder contains password-protected files
    const passwordProtected = files.filter(f => f.op_password_hash);
    if (passwordProtected.length > 0) {
      throw new ApiError(403, `Folder contains ${passwordProtected.length} password-protected file(s). Remove passwords first.`);
    }

    const messageIds = [];

    for (const file of files) {
      if (file.message_ids) {
        messageIds.push(...file.message_ids.split('|').filter(Boolean));
      }
    }

    if (messageIds.length > 0) {
      const uniqueIds = Array.from(new Set(messageIds));
      await discord.deleteMessagesBulk(uniqueIds);
    }
  }

  const deleted = db.deleteFolder(Number(id));
  res.json({ message: 'Folder deleted', folder: deleted });
}));

// PATCH /api/folders/reorder - Reorder folders
router.patch('/reorder', asyncHandler(async (req, res) => {
  const { orderedIds } = req.body;

  if (!Array.isArray(orderedIds)) {
    throw new ApiError(400, 'orderedIds must be an array');
  }

  const accessible = db.getAllFolders(req.user?.id || null, !req.user);
  const allowedIds = new Set(accessible.map(f => f.id));
  const invalid = orderedIds.some(id => !allowedIds.has(id));
  if (invalid) {
    throw new ApiError(403, 'Cannot reorder folders you do not own');
  }

  db.reorderFolders(orderedIds);
  const folders = db.getAllFolders(req.user?.id || null, !req.user);
  res.json(folders);
}));

module.exports = router;
