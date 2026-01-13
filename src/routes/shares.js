const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const { verifyPassword } = require('../utils/password');

function ensureFilePasswordForShare(req, file) {
  if (!file?.op_password_hash) return;
  const provided = req.headers['x-file-password'] || req.body?.password;
  if (!provided || !verifyPassword(provided, file.op_password_salt, file.op_password_hash)) {
    throw new ApiError(403, 'Password required or incorrect for this file');
  }
}

function ensureFolderPasswordForShare(req, folder) {
  if (!folder?.op_password_hash) return;
  const provided = req.headers['x-folder-password'] || req.body?.password;
  if (!provided || !verifyPassword(provided, folder.op_password_salt, folder.op_password_hash)) {
    throw new ApiError(403, 'Password required or incorrect for this folder');
  }
}

// POST /api/shares - Create a share link
router.post('/', asyncHandler(async (req, res) => {
  const { fileId, folderId, encryptedKey, encryptedKeySalt, keyWrapMethod, requirePassword = false, allowInsecure = false, urlKey = null, mediaWidth = null, mediaHeight = null, allowEmbed = true } = req.body;

  if (!fileId && !folderId) {
    throw new ApiError(400, 'Either fileId or folderId is required');
  }

  if (fileId && folderId) {
    throw new ApiError(400, 'Cannot share both file and folder at once');
  }

  // Verify resource exists and get file dimensions
  let fileDimensions = { width: null, height: null };
  if (fileId) {
    const file = db.getFileById(fileId);
    if (!file) {
      throw new ApiError(404, 'File not found');
    }
    if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
      throw new ApiError(403, 'Forbidden');
    }
    ensureFilePasswordForShare(req, file);
    // Get dimensions from file (stored during upload)
    fileDimensions.width = file.media_width ?? null;
    fileDimensions.height = file.media_height ?? null;
  }

  if (folderId) {
    const folder = db.getFolderById(folderId);
    if (!folder) {
      throw new ApiError(404, 'Folder not found');
    }
    if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
      throw new ApiError(403, 'Forbidden');
    }
    ensureFolderPasswordForShare(req, folder);
  }

  // Validate wrapped key payload - required for new shares (backward compat: allow missing)
  if (encryptedKey && !encryptedKeySalt) {
    throw new ApiError(400, 'encryptedKeySalt is required when encryptedKey is provided');
  }

  // Use dimensions from request, or fall back to file dimensions from upload
  const finalWidth = mediaWidth ?? fileDimensions.width;
  const finalHeight = mediaHeight ?? fileDimensions.height;

  const share = db.createShare(fileId || null, folderId || null, {
    encryptedKey: encryptedKey || null,
    encryptedKeySalt: encryptedKeySalt || null,
    keyWrapMethod: keyWrapMethod || 'pbkdf2-aes-gcm-100k',
    requirePassword: !!requirePassword,
    allowInsecure: !!allowInsecure,
    urlKey: allowInsecure ? urlKey : null,
    mediaWidth: finalWidth,
    mediaHeight: finalHeight,
    allowEmbed: allowEmbed !== false,
  });
  res.status(201).json({ success: true, share });
}));

// GET /api/shares - List all shares
router.get('/', asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new ApiError(401, 'Unauthorized');
  }
  const shares = db.getAllShares().filter((share) => {
    if (share.file_id) {
      const file = db.getFileById(share.file_id);
      return file && file.user_id === req.user.id;
    }
    if (share.folder_id) {
      const folder = db.getFolderById(share.folder_id);
      return folder && folder.user_id === req.user.id;
    }
    return false;
  });
  res.json({ success: true, shares });
}));

// GET /api/shares/file/:fileId - Get shares for a file
router.get('/file/:fileId', asyncHandler(async (req, res) => {
  const fileId = parseInt(req.params.fileId, 10);
  const file = db.getFileById(fileId);
  if (!file) {
    throw new ApiError(404, 'File not found');
  }
  if (file.user_id && (!req.user || req.user.id !== file.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  const shares = db.getSharesForFile(fileId);
  res.json({ success: true, shares });
}));

// GET /api/shares/folder/:folderId - Get shares for a folder
router.get('/folder/:folderId', asyncHandler(async (req, res) => {
  const folderId = parseInt(req.params.folderId, 10);
  const folder = db.getFolderById(folderId);
  if (!folder) {
    throw new ApiError(404, 'Folder not found');
  }
  if (folder.user_id && (!req.user || req.user.id !== folder.user_id)) {
    throw new ApiError(403, 'Forbidden');
  }
  const shares = db.getSharesForFolder(folderId);
  res.json({ success: true, shares });
}));

// DELETE /api/shares/:id - Revoke a share
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = db.deleteShare(id);

  if (!deleted) {
    throw new ApiError(404, 'Share not found');
  }

  res.json({ success: true, message: 'Share revoked' });
}));

module.exports = router;
