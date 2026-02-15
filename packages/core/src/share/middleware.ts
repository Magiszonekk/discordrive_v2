import crypto from 'crypto';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { ResolvedConfig, ShareRecord, FileRecord, FolderRecord } from '../types.js';
import type { DiscordriveDatabase } from '../db/database.js';
import type { BotPool } from '../discord/bot-pool.js';
import { formatFileSize } from '../utils/file.js';
import { downloadPartsToFile } from '../download/part-downloader.js';
import { createDecryptionStream } from '../crypto/decrypt.js';
import { resolvePartUrls } from '../download/url-resolver.js';

const pbkdf2Async = promisify(crypto.pbkdf2);

// Active download progress tracking
const activePublicDownloads = new Map<string, any>();

function ensureShareIsActive(share: ShareRecord | null): asserts share is ShareRecord {
  if (!share) throw Object.assign(new Error('Share not found'), { status: 404 });
  if (share.expires_at) {
    const expiresAt = new Date(share.expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
      throw Object.assign(new Error('This share link has expired'), { status: 410 });
    }
  }
}

function parseShareSecret(req: any): string | null {
  return req.query?.k || req.headers?.['x-share-secret'] || req.headers?.['x-share-password'] || null;
}

function getBaseUrl(req: any): string {
  const proto = req.headers?.['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
  return `${proto}://${host}`;
}

function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateOgTags(
  share: ShareRecord,
  file: FileRecord | null,
  folder: FolderRecord | null,
  baseUrl: string,
  queryPart: string,
): string {
  const isFile = !!share.file_id;
  const isImage = file?.mime_type?.startsWith('image/');
  const isVideo = file?.mime_type?.startsWith('video/');
  const canEmbed = share.allow_embed !== 0 && !!share.allow_insecure;

  const title = escapeHtml(isFile ? (file?.original_name || 'Shared file') : (folder?.name || 'Shared folder'));
  const size = isFile ? formatFileSize(file?.size || 0) : '';
  const description = escapeHtml(size ? `${size} • Discordrive` : 'Discordrive');
  const url = `${baseUrl}/s/${share.token}`;

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

async function decryptShareKey(share: ShareRecord, secret: string): Promise<string> {
  if (!share.encrypted_key || !share.encrypted_key_salt) {
    throw Object.assign(new Error('This share does not contain a wrapped key'), { status: 400 });
  }

  const method = share.key_wrap_method || 'pbkdf2-aes-gcm-100k';
  const salt = Buffer.from(share.encrypted_key_salt, 'base64');
  const combined = Buffer.from(share.encrypted_key, 'base64');
  const iv = combined.subarray(0, 12);
  const tagLength = 16;
  if (combined.length <= iv.length + tagLength) {
    throw Object.assign(new Error('Invalid wrapped key payload'), { status: 400 });
  }
  const ciphertext = combined.subarray(12, combined.length - tagLength);
  const authTag = combined.subarray(combined.length - tagLength);
  const iterations = parseInt(method.split('-').find(p => p.endsWith('k'))?.replace('k', '000') || '100000', 10) || 100000;

  try {
    const derivedKey = await pbkdf2Async(secret, salt, iterations, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey as Buffer, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw Object.assign(new Error('Invalid password or key'), { status: 401 });
  }
}

async function resolveShareKey(share: ShareRecord, req: any, config: ResolvedConfig): Promise<string | null> {
  // Unencrypted files don't need a key
  if (!share.encrypted_key && !config.encryptionKey) return null;

  if (share.encrypted_key) {
    let secret = parseShareSecret(req);
    if (!secret && share.allow_insecure && share.url_key) {
      secret = share.url_key;
    }
    if (!secret) {
      if (share.require_password) {
        throw Object.assign(new Error('Password required for this share'), { status: 401 });
      }
      throw Object.assign(new Error('Share secret required'), { status: 401 });
    }
    return decryptShareKey(share, secret);
  }

  return config.encryptionKey;
}

function buildContentDisposition(filename: string): string {
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function setProgress(token: string, data: any): void {
  const existing = activePublicDownloads.get(token) || {};
  const startedAt = existing.startedAt || Date.now();
  const merged = { ...existing, ...data, startedAt, updatedAt: Date.now() };

  if (merged.completedParts != null && merged.totalParts) {
    const elapsed = Date.now() - startedAt;
    if (merged.completedParts > 0) {
      const perPart = elapsed / merged.completedParts;
      merged.etaMs = Math.max(0, Math.round((merged.totalParts - merged.completedParts) * perPart));
    }
  }

  activePublicDownloads.set(token, merged);
}

async function downloadEncryptedFileToTemp(
  file: FileRecord,
  prefix: string,
  config: ResolvedConfig,
  onProgress?: (p: { completedParts: number; totalParts: number; percent: number }) => void,
  botPool?: BotPool,
  db?: DiscordriveDatabase,
): Promise<string> {
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const tempFile = path.join(
    config.tempDir,
    `${prefix}-${file.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.enc`,
  );

  // Resolve fresh Discord URLs if botPool is available
  let parts = file.parts || [];
  if (botPool) {
    parts = await resolvePartUrls(parts, botPool, db);
  }

  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    fileHandle = await fs.promises.open(tempFile, 'w');
    const totalEncryptedSize = parts.reduce((sum, part) => sum + part.size, 0);
    await fileHandle.truncate(totalEncryptedSize);
    await downloadPartsToFile(
      parts,
      fileHandle,
      config.chunkSize,
      config.downloadConcurrency,
      (completed, total) => {
        if (onProgress) {
          const percent = Math.round((completed / Math.max(total, 1)) * 100);
          onProgress({ completedParts: completed, totalParts: total, percent });
        }
      },
    );
  } finally {
    if (fileHandle) await fileHandle.close().catch(() => {});
  }

  return tempFile;
}

/**
 * Create an Express Router that serves share URLs.
 *
 * Mount it in your Express app: `app.use('/s', createShareRouter({ db, config }))`
 *
 * Routes:
 *   GET /:token         — HTML page with OG tags + download trigger
 *   GET /:token/info    — JSON metadata
 *   GET /:token/download — Stream decrypted file
 *   GET /:token/stream  — Video/audio streaming for embeds
 *   GET /:token/thumb   — Image thumbnail for embeds
 *   GET /:token/progress — SSE download progress
 */
export function createShareRouter(deps: {
  db: DiscordriveDatabase;
  config: ResolvedConfig;
  botPool?: BotPool;
}): any {
  // Lazy-import express to respect the optional peer dependency
  let express: any;
  try {
    express = require('express');
  } catch {
    throw new Error(
      '@discordrive/core: express is required for share middleware. Install it: npm install express',
    );
  }

  const { db, config, botPool } = deps;
  const router = express.Router();

  function asyncHandler(fn: (req: any, res: any, next: any) => Promise<any>) {
    return (req: any, res: any, next: any) => {
      fn(req, res, next).catch((err: any) => {
        const status = err.status || 500;
        if (!res.headersSent) {
          res.status(status).json({ success: false, error: err.message });
        }
      });
    };
  }

  // GET /:token/info
  router.get('/:token/info', asyncHandler(async (req: any, res: any) => {
    const share = db.getShareByToken(req.params.token);
    ensureShareIsActive(share);

    if (share.file_id) {
      const file = db.getFileById(share.file_id);
      if (!file) throw Object.assign(new Error('File not found'), { status: 404 });
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

    const folder = db.getFolderById(share.folder_id!);
    if (!folder) throw Object.assign(new Error('Folder not found'), { status: 404 });
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
          fileCount: folder.file_count ?? 0,
        },
      },
    });
  }));

  // GET /:token/thumb
  router.get('/:token/thumb', asyncHandler(async (req: any, res: any) => {
    const share = db.getShareByToken(req.params.token);
    ensureShareIsActive(share);
    if (!share.allow_insecure) throw Object.assign(new Error('Thumbnail only available for links with embedded key'), { status: 403 });
    if (!share.file_id) throw Object.assign(new Error('Thumbnail only available for file shares'), { status: 404 });

    const file = db.getFileById(share.file_id);
    if (!file) throw Object.assign(new Error('File not found'), { status: 404 });
    if (!file.mime_type?.startsWith('image/')) throw Object.assign(new Error('Not an image file'), { status: 404 });

    const encryptionKey = await resolveShareKey(share, req, config);
    const tempFile = await downloadEncryptedFileToTemp(file, 'share-thumb', config, undefined, botPool, db);

    try {
      const { stream: plainStream } = await createDecryptionStream(tempFile, file, encryptionKey);
      res.setHeader('Content-Type', file.mime_type);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      await pipeline(plainStream, res);
    } finally {
      await fs.promises.unlink(tempFile).catch(() => {});
    }
  }));

  // GET /:token/stream
  router.get('/:token/stream', asyncHandler(async (req: any, res: any) => {
    const share = db.getShareByToken(req.params.token);
    ensureShareIsActive(share);
    if (!share.allow_insecure) throw Object.assign(new Error('Stream only available for links with embedded key'), { status: 403 });
    if (!share.file_id) throw Object.assign(new Error('Stream only available for file shares'), { status: 404 });

    const file = db.getFileById(share.file_id);
    if (!file) throw Object.assign(new Error('File not found'), { status: 404 });
    if (!file.mime_type?.startsWith('video/') && !file.mime_type?.startsWith('audio/')) {
      throw Object.assign(new Error('Not a video/audio file'), { status: 404 });
    }

    const encryptionKey = await resolveShareKey(share, req, config);
    const tempFile = await downloadEncryptedFileToTemp(file, 'share-stream', config, undefined, botPool, db);

    try {
      const { stream: plainStream } = await createDecryptionStream(tempFile, file, encryptionKey);
      res.setHeader('Content-Type', file.mime_type);
      res.setHeader('Content-Length', file.size);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      await pipeline(plainStream, res);
    } finally {
      await fs.promises.unlink(tempFile).catch(() => {});
    }
  }));

  // GET /:token/progress (SSE)
  router.get('/:token/progress', (req: any, res: any) => {
    const token = req.params.token;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = () => {
      const progress = activePublicDownloads.get(token);
      res.write(`data: ${JSON.stringify(progress || { status: 'idle' })}\n\n`);
    };

    send();
    const interval = setInterval(send, 500);
    req.on('close', () => clearInterval(interval));
  });

  // GET /:token/download
  router.get('/:token/download', asyncHandler(async (req: any, res: any) => {
    const token = req.params.token;
    const share = db.getShareByToken(token);
    ensureShareIsActive(share);

    if (!share.file_id) throw Object.assign(new Error('Folder download not yet supported in core middleware'), { status: 400 });

    const file = db.getFileById(share.file_id);
    if (!file) throw Object.assign(new Error('File not found for this share'), { status: 404 });

    const encryptionKey = await resolveShareKey(share, req, config);

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

    const tempFile = await downloadEncryptedFileToTemp(file, 'share-file', config, (p) => {
      setProgress(token, {
        type: 'file',
        status: 'downloading',
        completedParts: p.completedParts,
        totalParts: p.totalParts,
        percent: p.percent,
        filename: file.original_name,
      });
    }, botPool, db);

    try {
      const { stream: plainStream } = await createDecryptionStream(tempFile, file, encryptionKey);
      setProgress(token, { type: 'file', status: 'decrypting', percent: 100, filename: file.original_name });
      await pipeline(plainStream, res);
      db.incrementShareAccessCount(share.token);
      setProgress(token, { type: 'file', status: 'complete', percent: 100, filename: file.original_name });
    } catch (err: any) {
      setProgress(token, { type: 'file', status: 'error', error: err.message, filename: file.original_name });
      throw err;
    } finally {
      await fs.promises.unlink(tempFile).catch(() => {});
      setTimeout(() => activePublicDownloads.delete(token), 10000);
    }
  }));

  // GET /:token — HTML page with OG tags
  router.get('/:token', asyncHandler(async (req: any, res: any) => {
    const token = req.params.token;
    const share = db.getShareByToken(token);
    ensureShareIsActive(share);

    const secret = parseShareSecret(req);
    const secretProvided = !!secret;
    const baseUrl = getBaseUrl(req);
    const queryPart = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

    const file = share.file_id ? db.getFileById(share.file_id) : null;
    const folder = share.folder_id ? db.getFolderById(share.folder_id) : null;
    const ogTags = generateOgTags(share, file, folder, baseUrl, queryPart);

    const hasStoredKey = share.allow_insecure && share.url_key;

    if (share.encrypted_key && !secretProvided && !hasStoredKey) {
      const title = share.file_id ? (share.file_name || 'Shared file') : (share.folder_name || 'Shared folder');
      const needsPassword = !!share.require_password;
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unlock ${escapeHtml(title)}</title>
  ${ogTags}
  <style>
    *{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#171717;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
    .card{width:100%;max-width:420px;background:#262626;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    .title{font-size:18px;font-weight:700;margin:0 0 6px}.muted{color:#a3a3a3;font-size:14px;margin:0 0 16px}
    input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:#171717;color:#fafafa;font-size:15px}input:focus{outline:none;border-color:#38bdf8}
    button{margin-top:12px;width:100%;background:#38bdf8;color:#0b1221;border:none;padding:10px;font-weight:700;border-radius:10px;cursor:pointer}button:hover{opacity:.9}
    .hint{color:#a3a3a3;font-size:13px;margin-top:8px}
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Unlock to download</div>
    <div class="muted">${escapeHtml(title)}</div>
    <input id="secret" type="password" placeholder="${needsPassword ? 'Password' : 'Password or key'}" autocomplete="off" />
    <div class="hint">${needsPassword ? 'Password required.' : 'This link requires a password or key.'}</div>
    <button id="submit">Continue</button>
  </div>
  <script>
    document.getElementById('submit').addEventListener('click',()=>{const v=document.getElementById('secret').value||'';if(!v.trim())return;const p=new URLSearchParams(window.location.search);p.set('k',v);window.location.href='/s/${token}?'+p.toString()});
    document.getElementById('secret').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('submit').click()});
  </script>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    const title = share.file_id ? (share.file_name || 'Shared file') : (share.folder_name || 'Shared folder');
    const sizeText = share.file_id && share.file_size ? formatFileSize(share.file_size) : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Downloading ${escapeHtml(title)}</title>
  ${ogTags}
  <style>
    *{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#171717;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
    .card{width:100%;max-width:520px;background:#262626;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    .title{font-size:18px;font-weight:700;margin:0 0 6px}.muted{color:#a3a3a3;font-size:14px;margin:0 0 16px}
    .bar{width:100%;height:10px;background:rgba(255,255,255,.1);border-radius:999px;overflow:hidden;margin:12px 0}
    .bar-fill{height:100%;width:6%;background:linear-gradient(90deg,#38bdf8,#6366f1);transition:width .2s ease}
    .status{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#d4d4d4}
    .sub{font-size:13px;color:#a3a3a3;margin-top:6px}
    .chip{padding:4px 10px;border-radius:999px;background:rgba(99,102,241,.2);color:#c7d2fe;font-weight:600;font-size:12px}
    .footer{margin-top:14px;font-size:12px;color:#737373}
    button{margin-top:12px;width:100%;background:#38bdf8;color:#0b1221;border:none;padding:10px;font-weight:700;border-radius:10px;cursor:pointer}button:hover:not(:disabled){opacity:.9}button:disabled{opacity:.6;cursor:not-allowed}
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Preparing download...</div>
    <div class="muted" id="meta">${escapeHtml(title)}${sizeText ? ' &bull; ' + sizeText : ''}</div>
    <div class="bar"><div class="bar-fill" id="bar"></div></div>
    <div class="status"><span id="statusText">Connecting...</span><span class="chip" id="chip">Starting</span></div>
    <div class="sub" id="partsText"></div>
    <div class="sub" id="etaText"></div>
    <div class="footer">If the download doesn't start automatically, <a href="/s/${token}/download${queryPart}" style="color:#38bdf8;">click here</a>.</div>
    <button id="downloadBtn">Start download</button>
  </div>
  <script>
    const bar=document.getElementById('bar'),statusText=document.getElementById('statusText'),chip=document.getElementById('chip'),partsText=document.getElementById('partsText'),etaText=document.getElementById('etaText'),btn=document.getElementById('downloadBtn');
    function formatEta(ms){if(!ms||ms<=0)return'';const s=Math.round(ms/1000);if(s<60)return s+'s';return Math.floor(s/60)+'m '+s%60+'s'}
    function updateProgress(p){const pct=Math.min(100,Math.max(0,p.percent||0));bar.style.width=pct+'%';if(p.completedParts!=null&&p.totalParts)partsText.textContent='Downloaded '+p.completedParts+'/'+p.totalParts+' part(s)';if(p.etaMs!=null)etaText.textContent='ETA: '+formatEta(p.etaMs);if(p.status==='complete'){statusText.textContent='Download complete!';chip.textContent='Complete';chip.style.background='rgba(34,197,94,.2)';chip.style.color='#86efac';btn.textContent='Download again';btn.disabled=false}else if(p.status==='downloading'){statusText.textContent='Downloading... '+pct+'%';chip.textContent='Downloading'}else if(p.status==='decrypting'){statusText.textContent='Preparing file...';chip.textContent='Finalizing'}else if(p.status==='error'){statusText.textContent='Error: '+(p.error||'Failed');chip.textContent='Error';chip.style.background='rgba(239,68,68,.2)';chip.style.color='#fca5a5';btn.textContent='Try again';btn.disabled=false}}
    function startDownload(){btn.disabled=true;btn.textContent='Downloading...';const a=document.createElement('a');a.href='/s/${token}/download${queryPart}';a.download='';document.body.appendChild(a);a.click();document.body.removeChild(a)}
    btn.addEventListener('click',startDownload);
    const es=new EventSource('/s/${token}/progress${queryPart}');es.onmessage=e=>{try{updateProgress(JSON.parse(e.data))}catch{}};
    startDownload();
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }));

  return router;
}
