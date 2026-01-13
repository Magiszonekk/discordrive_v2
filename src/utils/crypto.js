const crypto = require('crypto');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const HEADER_LENGTH = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

// Async PBKDF2 - uses libuv thread pool, doesn't block event loop
const pbkdf2Async = promisify(crypto.pbkdf2);

// Key cache to avoid repeated PBKDF2 derivation for same salt
// Key: salt (hex string), Value: { key: Buffer, lastUsed: timestamp }
const keyCache = new Map();
const KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const KEY_CACHE_MAX_SIZE = 100;

/**
 * Clean expired entries from key cache
 */
function cleanKeyCache() {
  const now = Date.now();
  for (const [saltHex, entry] of keyCache) {
    if (now - entry.lastUsed > KEY_CACHE_TTL) {
      keyCache.delete(saltHex);
    }
  }
  // If still over max size, remove oldest entries
  if (keyCache.size > KEY_CACHE_MAX_SIZE) {
    const entries = [...keyCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = entries.slice(0, keyCache.size - KEY_CACHE_MAX_SIZE);
    for (const [saltHex] of toRemove) {
      keyCache.delete(saltHex);
    }
  }
}

/**
 * Derive a 256-bit key from password using PBKDF2 (sync version for backward compat)
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

/**
 * Derive a 256-bit key from password using PBKDF2 (async version)
 * Uses cache to avoid repeated derivation for same salt
 * Optionally uses worker pool for true parallel execution
 */
async function deriveKeyAsync(password, salt, useWorkerPool = false) {
  const saltHex = salt.toString('hex');

  // Check cache first
  const cached = keyCache.get(saltHex);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.key;
  }

  let key;
  if (useWorkerPool) {
    // Use worker pool for true parallel execution
    const { getWorkerPool } = require('../services/worker-pool');
    const pool = getWorkerPool();
    key = await pool.deriveKey(password, salt);
  } else {
    // Use async PBKDF2 (uses libuv thread pool - good enough for most cases)
    key = await pbkdf2Async(password, salt, 100000, 32, 'sha256');
  }

  // Cache the result
  cleanKeyCache();
  keyCache.set(saltHex, { key, lastUsed: Date.now() });

  return key;
}

function buildHeader(salt, iv, authTag) {
  return Buffer.concat([salt, iv, authTag]);
}

function parseHeader(buffer) {
  if (buffer.length < HEADER_LENGTH) {
    throw new Error('Invalid encrypted buffer header');
  }

  return {
    salt: buffer.subarray(0, SALT_LENGTH),
    iv: buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH),
    authTag: buffer.subarray(SALT_LENGTH + IV_LENGTH, HEADER_LENGTH),
  };
}

/**
 * Encrypt a buffer with AES-256-GCM
 * Returns: salt (32) + iv (16) + authTag (16) + encryptedData
 */
function encrypt(buffer, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // Combine: salt + iv + authTag + encrypted data
  return Buffer.concat([buildHeader(salt, iv, authTag), encrypted]);
}

/**
 * Decrypt a buffer encrypted with encrypt()
 */
function decrypt(encryptedBuffer, password) {
  const header = encryptedBuffer.subarray(0, HEADER_LENGTH);
  const data = encryptedBuffer.subarray(HEADER_LENGTH);
  const { salt, iv, authTag } = parseHeader(header);

  const key = deriveKey(password, salt);
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

async function encryptFileToDisk(inputPath, outputPath, password, onProgress) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const writeStream = fs.createWriteStream(outputPath, { flags: 'w' });

  // Reserve header space so we can fill it once encryption completes
  await new Promise((resolve, reject) => {
    writeStream.write(Buffer.alloc(HEADER_LENGTH), err => (err ? reject(err) : resolve()));
  });

  const sourceStats = await fs.promises.stat(inputPath);
  const totalBytes = sourceStats.size;
  let processedBytes = 0;
  const readStream = fs.createReadStream(inputPath);

  if (typeof onProgress === 'function' && totalBytes > 0) {
    readStream.on('data', chunk => {
      processedBytes += chunk.length;
      onProgress({
        processedBytes,
        totalBytes,
        percent: processedBytes / totalBytes,
      });
    });
  }

  await pipeline(readStream, cipher, writeStream);

  const authTag = cipher.getAuthTag();
  const header = buildHeader(salt, iv, authTag);
  const handle = await fs.promises.open(outputPath, 'r+');
  await handle.write(header, 0, header.length, 0);
  await handle.close();
  const stats = await fs.promises.stat(outputPath);

  if (typeof onProgress === 'function') {
    onProgress({
      processedBytes: totalBytes,
      totalBytes,
      percent: 1,
    });
  }

  return {
    header,
    encryptedSize: stats.size,
  };
}

function createDecipherFromHeader(headerBuffer, password) {
  const { salt, iv, authTag } = parseHeader(headerBuffer);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher;
}

/**
 * Create decipher from header (async version - uses cached keys)
 */
async function createDecipherFromHeaderAsync(headerBuffer, password) {
  const { salt, iv, authTag } = parseHeader(headerBuffer);
  const key = await deriveKeyAsync(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher;
}

/**
 * Get overhead size added by encryption
 */
function getEncryptionOverhead() {
  return HEADER_LENGTH;
}

module.exports = {
  encrypt,
  decrypt,
  getEncryptionOverhead,
  encryptFileToDisk,
  createDecipherFromHeader,
  createDecipherFromHeaderAsync,
  deriveKeyAsync,
  HEADER_LENGTH,
};
