const express = require('express');
const archiver = require('archiver');
const crypto = require('crypto');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const fs = require('fs');

const pbkdf2Async = promisify(crypto.pbkdf2);
const db = require('../db');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const { formatFileSize } = require('../utils/file');
const { appendFileToArchive, downloadEncryptedFileToTemp, createDecryptionStream } = require('../services/storageAssembler');
const { downloadRangeStream, resolveConfig } = require('@discordrive/core');
const { toCoreConfig } = require('../config');

const router = express.Router();
const activePublicDownloads = new Map(); // token -> progress state

function ensureShareIsActive(share) {
  if (!share) {
    throw new ApiError(404, 'Share not found');
  }
  if (share.expires_at) {
    const expiresAt = new Date(share.expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
      throw new ApiError(410, 'This share link has expired');
    }
  }
}

/**
 * Convert URL-safe base64 back to standard base64
 */
function fromUrlSafeBase64(urlSafe) {
  let base64 = urlSafe.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  if (padding > 0 && padding < 4) {
    base64 += '='.repeat(padding);
  }
  return base64;
}

function parseShareSecret(req) {
  const raw = req.query?.k || req.headers['x-share-secret'] || req.headers['x-share-password'] || null;
  // Return as-is - the secret was encrypted using URL-safe base64 format
  return raw || null;
}

/**
 * Get base URL from request headers (for OG tags)
 */
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate Open Graph meta tags for Discord/social embeds
 */
function generateOgTags(share, file, folder, baseUrl, queryPart) {
  const isFile = !!share.file_id;
  const isImage = file?.mime_type?.startsWith('image/');
  const isVideo = file?.mime_type?.startsWith('video/');
  // Embeds enabled if allow_embed is not explicitly 0 AND share is insecure (has accessible key)
  const canEmbed = share.allow_embed !== 0 && !!share.allow_insecure;

  const title = escapeHtml(isFile ? (file?.original_name || 'Shared file') : (folder?.name || 'Shared folder'));
  const size = isFile ? formatFileSize(file?.size || 0) : (folder ? `${folder.fileCount || 0} files` : '');
  const description = escapeHtml(size ? `${size} • Discordrive` : 'Discordrive');
  const url = `${baseUrl}/s/${share.token}`;

  // Use dynamic dimensions from share or fallback to 16:9
  const mediaWidth = share.media_width || 1280;
  const mediaHeight = share.media_height || 720;

  let tags = `
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:type" content="${isVideo ? 'video.other' : 'website'}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:site_name" content="Discordrive" />
    <meta name="twitter:card" content="${isVideo ? 'player' : 'summary'}" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />`;

  if (canEmbed && isImage && file) {
    const thumbUrl = `${baseUrl}/s/${share.token}/thumb${queryPart}`;
    tags += `
    <meta property="og:image" content="${thumbUrl}" />
    <meta property="og:image:width" content="${mediaWidth}" />
    <meta property="og:image:height" content="${mediaHeight}" />
    <meta name="twitter:image" content="${thumbUrl}" />`;
  }

  if (canEmbed && isVideo && file) {
    const streamUrl = `${baseUrl}/s/${share.token}/stream${queryPart}`;
    tags += `
    <meta property="og:video" content="${streamUrl}" />
    <meta property="og:video:secure_url" content="${streamUrl}" />
    <meta property="og:video:type" content="${file.mime_type}" />
    <meta property="og:video:width" content="${mediaWidth}" />
    <meta property="og:video:height" content="${mediaHeight}" />`;
  }

  return tags;
}

async function decryptShareKey(share, secret) {
  if (!share.encrypted_key || !share.encrypted_key_salt) {
    throw new ApiError(400, 'This share does not contain a wrapped key');
  }
  if (!secret || typeof secret !== 'string' || !secret.trim()) {
    if (share.require_password) {
      throw new ApiError(401, 'Password required for this share');
    }
    throw new ApiError(401, 'Share secret required');
  }

  const method = share.key_wrap_method || 'pbkdf2-aes-gcm-100k';
  if (!method.startsWith('pbkdf2')) {
    throw new ApiError(400, 'Unsupported key wrap method');
  }

  const salt = Buffer.from(share.encrypted_key_salt, 'base64');
  const combined = Buffer.from(share.encrypted_key, 'base64');
  const iv = combined.subarray(0, 12);
  const tagLength = 16;
  if (combined.length <= iv.length + tagLength) {
    throw new ApiError(400, 'Invalid wrapped key payload');
  }
  const ciphertext = combined.subarray(12, combined.length - tagLength);
  const authTag = combined.subarray(combined.length - tagLength);
  const iterations = parseInt(method.split('-').find((p) => p.endsWith('k'))?.replace('k', '000') || '100000', 10) || 100000;

  try {
    const derivedKey = await pbkdf2Async(secret, salt, iterations, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new ApiError(401, 'Invalid password or key');
  }
}

async function resolveShareKey(share, req) {
  if (share.encrypted_key) {
    let secret = parseShareSecret(req);

    // For insecure shares with stored url_key, auto-use it if no secret provided
    if (!secret && share.allow_insecure && share.url_key) {
      secret = share.url_key;
    }

    return decryptShareKey(share, secret);
  }
  // Fallback to server key for legacy shares
  const { config } = require('../config');
  if (config.encryption.key) return config.encryption.key;
  throw new ApiError(401, 'No key available to decrypt this share');
}

function buildContentDisposition(filename) {
  // ASCII-safe fallback name (replace non-ASCII with underscores)
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  // Full UTF-8 encoded name for modern browsers
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function setProgress(token, data) {
  const existing = activePublicDownloads.get(token) || {};
  const startedAt = existing.startedAt || Date.now();
  const merged = { ...existing, ...data, startedAt, updatedAt: Date.now() };

  if (merged.completedParts != null && merged.totalParts) {
    const elapsed = Date.now() - startedAt;
    if (merged.completedParts > 0) {
      const perPart = elapsed / merged.completedParts;
      merged.etaMs = Math.max(
        0,
        Math.round((merged.totalParts - merged.completedParts) * perPart)
      );
    }
  }

  activePublicDownloads.set(token, merged);
}

async function streamFileShareDownload(share, token, res) {
  const file = db.getFileById(share.file_id);
  if (!file) {
    throw new ApiError(404, 'File not found for this share');
  }

  // EARLY PASSWORD/KEY VERIFICATION - before downloading from Discord
  const encryptionKey = await resolveShareKey(share, res.req);

  setProgress(token, {
    type: 'file',
    status: 'downloading',
    completedParts: 0,
    totalParts: file.total_parts,
    percent: 0,
    filename: file.original_name,
  });

  res.setHeader('Content-Disposition', buildContentDisposition(file.original_name));
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', file.size);

  const tempFile = await downloadEncryptedFileToTemp(file, 'share-file', (p) => {
    setProgress(token, {
      type: 'file',
      status: 'downloading',
      completedParts: p.completedParts,
      totalParts: p.totalParts,
      percent: p.percent,
      filename: file.original_name,
    });
  });

  try {
    const { stream: plainStream } = await createDecryptionStream(tempFile, file, encryptionKey);
    setProgress(token, { type: 'file', status: 'decrypting', percent: 100, filename: file.original_name });
    await pipeline(plainStream, res);
    db.incrementShareAccessCount(share.token);
    setProgress(token, { type: 'file', status: 'complete', percent: 100, filename: file.original_name });
  } catch (err) {
    setProgress(token, { type: 'file', status: 'error', error: err.message, filename: file.original_name });
    throw err;
  } finally {
    await fs.promises.unlink(tempFile).catch(() => {});
    setTimeout(() => activePublicDownloads.delete(token), 10000);
  }
}

async function streamFolderShareDownload(share, token, res) {
  const folder = db.getFolderById(share.folder_id);
  if (!folder) {
    throw new ApiError(404, 'Folder not found for this share');
  }

  const encryptionKey = await resolveShareKey(share, res.req);

  const folderFiles = db.getFilesInFolder(folder.id, folder.user_id || null, true);
  const filesWithParts = folderFiles
    .map(file => db.getFileById(file.id))
    .filter(Boolean);

  // Block if folder contains password-protected files
  const passwordProtected = filesWithParts.filter(f => f.op_password_hash);
  if (passwordProtected.length > 0) {
    throw new ApiError(403, `Folder contains ${passwordProtected.length} password-protected file(s). Remove passwords first.`);
  }

  const totalPartsAll = filesWithParts.reduce(
    (sum, f) => sum + (f.total_parts || f.totalParts || (Array.isArray(f.parts) ? f.parts.length : 0) || 0),
    0
  );

  const archive = archiver('zip', { zlib: { level: 9 } });
  let archiveError = null;
  archive.on('warning', err => {
    if (err.code !== 'ENOENT') {
      console.warn('[Archive warning]', err.message);
    }
  });
  archive.on('error', err => {
    console.error('[Archive error]', err);
    archiveError = err;
  });

  const zipName = `${folder.name}.zip`;
  res.setHeader('Content-Disposition', buildContentDisposition(zipName));
  res.setHeader('Content-Type', 'application/zip');

  const archivePipeline = pipeline(archive, res);

  setProgress(token, {
    type: 'folder',
    status: 'preparing',
    fileCount: filesWithParts.length,
    currentFileIndex: 0,
    percent: 0,
    completedParts: 0,
    totalParts: totalPartsAll,
    folderName: folder.name,
  });

  let processedFiles = 0;
  let completedPartsAll = 0;

  try {
    for (const file of filesWithParts) {
      processedFiles += 1;
      const currentIndex = processedFiles;
      const filePartsTotal = file.total_parts || file.totalParts || (Array.isArray(file.parts) ? file.parts.length : 0) || 0;
      setProgress(token, {
        type: 'folder',
        status: 'downloading_file',
        fileCount: filesWithParts.length,
        currentFileIndex: currentIndex,
        currentFileName: file.original_name,
        percent: Math.round(((currentIndex - 1) / Math.max(filesWithParts.length, 1)) * 100),
        completedParts: completedPartsAll,
        totalParts: totalPartsAll,
        folderName: folder.name,
      });

      await appendFileToArchive(file, archive, {
        prefix: 'share-folder',
        encryptionKey,
        onProgress: (p) => {
          const base = (currentIndex - 1) / Math.max(filesWithParts.length, 1);
          const overallPercent = Math.round((base + (p.percent / 100) * (1 / Math.max(filesWithParts.length, 1))) * 100);
          const overallCompleted = completedPartsAll + (p.completedParts || 0);
          setProgress(token, {
            type: 'folder',
            status: 'downloading_file',
            fileCount: filesWithParts.length,
            currentFileIndex: currentIndex,
            currentFileName: file.original_name,
            percent: overallPercent,
            currentFileParts: p.completedParts,
            currentFileTotalParts: p.totalParts,
            completedParts: overallCompleted,
            totalParts: totalPartsAll,
            folderName: folder.name,
          });
        },
      });

      completedPartsAll += filePartsTotal;
    }

    if (archiveError) {
      throw new ApiError(500, 'Archive creation failed: ' + archiveError.message);
    }

    await archive.finalize();
    await archivePipeline;
    db.incrementShareAccessCount(share.token);
    setProgress(token, {
      type: 'folder',
      status: 'complete',
      fileCount: filesWithParts.length,
      currentFileIndex: filesWithParts.length,
      percent: 100,
      completedParts: totalPartsAll,
      totalParts: totalPartsAll,
      folderName: folder.name,
    });
  } catch (err) {
    setProgress(token, { type: 'folder', status: 'error', error: err.message, folderName: folder.name });
    throw err;
  } finally {
    setTimeout(() => activePublicDownloads.delete(token), 10000);
  }
}

// GET /s/:token/info - public metadata about a share
router.get('/:token/info', asyncHandler(async (req, res) => {
  const share = db.getShareByToken(req.params.token);
  ensureShareIsActive(share);

  if (share.file_id) {
    const file = db.getFileById(share.file_id);
    if (!file) {
      throw new ApiError(404, 'File not found');
    }
    res.json({
      success: true,
      share: {
        token: share.token,
        type: 'file',
        createdAt: share.created_at,
        expiresAt: share.expires_at,
        accessCount: share.access_count,
        requirePassword: !!share.require_password,
        allowInsecure: !!share.allow_insecure,
        hasWrappedKey: !!share.encrypted_key,
        file: {
          id: file.id,
          name: file.original_name,
          size: file.size,
          sizeFormatted: formatFileSize(file.size),
          mimeType: file.mime_type,
        },
      },
    });
    return;
  }

  const folder = db.getFolderById(share.folder_id);
  if (!folder) {
    throw new ApiError(404, 'Folder not found');
  }

  const folderFiles = db.getFilesInFolder(folder.id, folder.user_id || null, true);
  const totalSize = folderFiles.reduce((sum, file) => sum + (file.size || 0), 0);

  res.json({
    success: true,
    share: {
      token: share.token,
      type: 'folder',
      createdAt: share.created_at,
      expiresAt: share.expires_at,
      accessCount: share.access_count,
      requirePassword: !!share.require_password,
      allowInsecure: !!share.allow_insecure,
      hasWrappedKey: !!share.encrypted_key,
      folder: {
        id: folder.id,
        name: folder.name,
        fileCount: folderFiles.length,
        totalSize,
        totalSizeFormatted: formatFileSize(totalSize),
      },
    },
  });
}));

// Thumbnail for image shares (for Discord/social embeds)
router.get('/:token/thumb', asyncHandler(async (req, res) => {
  const share = db.getShareByToken(req.params.token);
  ensureShareIsActive(share);

  // Only allow for insecure shares (with embedded key)
  if (!share.allow_insecure) {
    throw new ApiError(403, 'Thumbnail only available for links with embedded key');
  }

  if (!share.file_id) {
    throw new ApiError(404, 'Thumbnail only available for file shares');
  }

  const file = db.getFileById(share.file_id);
  if (!file) {
    throw new ApiError(404, 'File not found');
  }

  if (!file.mime_type?.startsWith('image/')) {
    throw new ApiError(404, 'Not an image file');
  }

  const encryptionKey = await resolveShareKey(share, req);

  // Download and decrypt the image
  const tempFile = await downloadEncryptedFileToTemp(file, 'share-thumb');

  try {
    const { stream: plainStream } = await createDecryptionStream(tempFile, file, encryptionKey);

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h
    await pipeline(plainStream, res);
  } finally {
    await fs.promises.unlink(tempFile).catch(() => {});
  }
}));

// Stream video/audio with HTTP Range support for seeking
router.get('/:token/stream', asyncHandler(async (req, res) => {
  const share = db.getShareByToken(req.params.token);
  ensureShareIsActive(share);

  if (!share.allow_insecure) {
    throw new ApiError(403, 'Stream only available for links with embedded key');
  }

  if (!share.file_id) {
    throw new ApiError(404, 'Stream only available for file shares');
  }

  const file = db.getFileById(share.file_id);
  if (!file) {
    throw new ApiError(404, 'File not found');
  }

  if (!file.mime_type?.startsWith('video/') && !file.mime_type?.startsWith('audio/')) {
    throw new ApiError(404, 'Not a video/audio file');
  }

  const encryptionKey = await resolveShareKey(share, req);
  const fileSize = file.size;

  // Parse Range header
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const rangeStart = parseInt(match[1], 10);
    const rangeEnd = match[2] ? parseInt(match[2], 10) : Math.min(rangeStart + 8 * 1024 * 1024 - 1, fileSize - 1);

    if (rangeStart >= fileSize || rangeEnd >= fileSize || rangeStart > rangeEnd) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const coreConfig = resolveConfig(toCoreConfig());
    const rangeStream = await downloadRangeStream(file, rangeStart, rangeEnd, coreConfig, encryptionKey);
    const contentLength = rangeEnd - rangeStart + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${fileSize}`);
    res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    await pipeline(rangeStream, res);
    return;
  }

  // No Range header — full download
  const tempFile = await downloadEncryptedFileToTemp(file, 'share-stream');

  try {
    const { stream: plainStream } = await createDecryptionStream(tempFile, file, encryptionKey);

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    await pipeline(plainStream, res);
  } finally {
    await fs.promises.unlink(tempFile).catch(() => {});
  }
}));

// SSE progress for shared downloads
router.get('/:token/progress', asyncHandler(async (req, res) => {
  const token = req.params.token;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = () => {
    const progress = activePublicDownloads.get(token);
    if (progress) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ status: 'idle' })}\n\n`);
    }
  };

  send();
  const interval = setInterval(send, 500);
  req.on('close', () => clearInterval(interval));
}));

// Download a shared file or folder (folder downloads as ZIP)
router.get('/:token/download', asyncHandler(async (req, res) => {
  const token = req.params.token;
  const share = db.getShareByToken(token);
  ensureShareIsActive(share);

  if (share.file_id) {
    await streamFileShareDownload(share, token, res);
  } else if (share.folder_id) {
    await streamFolderShareDownload(share, token, res);
  } else {
    throw new ApiError(400, 'Invalid share');
  }
}));

// Progress page with auto-download
router.get('/:token', asyncHandler(async (req, res) => {
  const token = req.params.token;
  const share = db.getShareByToken(token);
  ensureShareIsActive(share);

  const secret = parseShareSecret(req);
  const secretProvided = !!secret;
  const baseUrl = getBaseUrl(req);
  const queryPart = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  // Get file/folder info for OG tags
  const file = share.file_id ? db.getFileById(share.file_id) : null;
  const folder = share.folder_id ? db.getFolderById(share.folder_id) : null;
  const ogTags = generateOgTags(share, file, folder, baseUrl, queryPart);

  // For insecure shares with url_key, skip unlock page (key stored on server)
  const hasStoredKey = share.allow_insecure && share.url_key;

  if (share.encrypted_key && !secretProvided && !hasStoredKey) {
    const title = share.file_id ? (share.file_name || 'Shared file') : (share.folder_name || 'Shared folder');
    const needsPassword = !!share.require_password;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unlock ${escapeHtml(title)}</title>
  ${ogTags}
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #171717; color: #fafafa; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { width: 100%; max-width: 420px; background: #262626; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
    .title { font-size: 18px; font-weight: 700; margin: 0 0 6px; }
    .muted { color: #a3a3a3; font-size: 14px; margin: 0 0 16px; }
    input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15); background: #171717; color: #fafafa; font-size: 15px; }
    input:focus { outline: none; border-color: #38bdf8; }
    button { margin-top: 12px; width: 100%; background: #38bdf8; color: #0b1221; border: none; padding: 10px; font-weight: 700; border-radius: 10px; cursor: pointer; transition: opacity 0.15s; }
    button:hover { opacity: 0.9; }
    .hint { color: #a3a3a3; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Unlock to download</div>
    <div class="muted">${title}</div>
    <input id="secret" type="password" placeholder="${needsPassword ? 'Password' : 'Password or key'}" autocomplete="off" />
    <div class="hint">${needsPassword ? 'Wymagane hasło do pobrania.' : 'Link wymaga hasła lub klucza w parametrze k.'}</div>
    <button id="submit">Continue</button>
  </div>
  <script>
    const btn = document.getElementById('submit');
    const input = document.getElementById('secret');
    btn.addEventListener('click', () => {
      const val = input.value || '';
      if (!val.trim()) return;
      const params = new URLSearchParams(window.location.search);
      params.set('k', val);
      window.location.href = '/s/${token}' + '?' + params.toString();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn.click();
    });
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
    return;
  }

  const title = share.file_id ? (share.file_name || 'Shared file') : (share.folder_name || 'Shared folder');
  const sizeText = share.file_id && share.file_size ? formatFileSize(share.file_size) : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Downloading ${escapeHtml(title)}</title>
  ${ogTags}
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #171717; color: #fafafa; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { width: 100%; max-width: 520px; background: #262626; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
    .title { font-size: 18px; font-weight: 700; margin: 0 0 6px; }
    .muted { color: #a3a3a3; font-size: 14px; margin: 0 0 16px; }
    .bar { width: 100%; height: 10px; background: rgba(255,255,255,0.1); border-radius: 999px; overflow: hidden; margin: 12px 0; }
    .bar-fill { height: 100%; width: 6%; background: linear-gradient(90deg, #38bdf8, #6366f1); transition: width 0.2s ease; }
    .status { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #d4d4d4; }
    .sub { font-size: 13px; color: #a3a3a3; margin-top: 6px; }
    .chip { padding: 4px 10px; border-radius: 999px; background: rgba(99,102,241,0.2); color: #c7d2fe; font-weight: 600; font-size: 12px; transition: all 0.2s; }
    .footer { margin-top: 14px; font-size: 12px; color: #737373; }
    button { margin-top: 12px; width: 100%; background: #38bdf8; color: #0b1221; border: none; padding: 10px; font-weight: 700; border-radius: 10px; cursor: pointer; transition: opacity 0.15s; }
    button:hover:not(:disabled) { opacity: 0.9; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Preparing download...</div>
    <div class="muted" id="meta">${title}${sizeText ? ' • ' + sizeText : ''}</div>
    <div class="bar"><div class="bar-fill" id="bar"></div></div>
    <div class="status"><span id="statusText">Connecting...</span><span class="chip" id="chip">Starting</span></div>
    <div class="sub" id="partsText"></div>
    <div class="sub" id="etaText"></div>
    <div class="footer">If the download doesn’t start automatically, <a href="/s/${token}/download${queryPart}" style="color:#38bdf8;">click here</a>.</div>
    <button id="downloadBtn">Start download</button>
  </div>
  <script>
    const bar = document.getElementById('bar');
    const statusText = document.getElementById('statusText');
    const chip = document.getElementById('chip');
    const partsText = document.getElementById('partsText');
    const etaText = document.getElementById('etaText');
    const btn = document.getElementById('downloadBtn');
    let started = false;

    function formatEta(ms) {
      if (!ms || ms <= 0) return '';
      const totalSec = Math.round(ms / 1000);
      if (totalSec < 60) return totalSec + 's';
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      return min + 'm ' + sec + 's';
    }

    function updateProgress(progress) {
      const percent = Math.min(100, Math.max(0, progress.percent ?? 0));
      bar.style.width = percent + '%';

      if (progress.completedParts != null && progress.totalParts) {
        partsText.textContent = 'Downloaded ' + progress.completedParts + '/' + progress.totalParts + ' part(s) from Discord';
      } else if (progress.currentFileIndex && progress.fileCount) {
        partsText.textContent = 'Downloading file ' + progress.currentFileIndex + '/' + progress.fileCount + (progress.currentFileName ? ' (' + progress.currentFileName + ')' : '');
      } else {
        partsText.textContent = '';
      }

      if (progress.etaMs != null) {
        etaText.textContent = 'Estimated time to start streaming: ' + formatEta(progress.etaMs);
      } else if (progress.totalParts && progress.completedParts != null) {
        etaText.textContent = 'Estimating time...';
      } else {
        etaText.textContent = '';
      }

      if (progress.status === 'complete') {
        statusText.textContent = 'Download complete!';
        chip.textContent = 'Complete';
        chip.style.background = 'rgba(34, 197, 94, 0.2)';
        chip.style.color = '#86efac';
        btn.textContent = 'Download again';
        btn.disabled = false;
        if (typeof es !== 'undefined') es.close();
      } else if (progress.status === 'downloading' || progress.status === 'downloading_file') {
        statusText.textContent = 'Downloading... ' + percent + '%';
        chip.textContent = 'Downloading';
      } else if (progress.status === 'decrypting' || progress.status === 'streaming') {
        statusText.textContent = 'Preparing file...';
        chip.textContent = 'Finalizing';
      } else if (progress.status === 'preparing') {
        statusText.textContent = 'Preparing...';
        chip.textContent = 'Starting';
      } else if (progress.status === 'error') {
        statusText.textContent = 'Error: ' + (progress.error || 'Download failed');
        chip.textContent = 'Error';
        chip.style.background = 'rgba(239, 68, 68, 0.2)';
        chip.style.color = '#fca5a5';
        btn.textContent = 'Try again';
        btn.disabled = false;
        if (typeof es !== 'undefined') es.close();
      } else {
        statusText.textContent = 'Waiting to start...';
        chip.textContent = 'Starting';
      }
    }

    function startDownload() {
      started = true;
      btn.disabled = true;
      btn.textContent = 'Downloading...';
      const link = document.createElement('a');
      link.href = '/s/${token}/download${queryPart}';
      link.download = '';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    btn.addEventListener('click', startDownload);

    const es = new EventSource('/s/${token}/progress${queryPart}');
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        updateProgress(data);
      } catch (_) {}
    };
    es.onerror = () => {};

    startDownload();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

module.exports = router;
