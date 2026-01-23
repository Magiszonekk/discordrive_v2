/**
 * Crypto Worker - handles CPU-intensive crypto operations in a separate thread
 *
 * Supported operations:
 * - deriveKey: PBKDF2 key derivation (100k iterations)
 * - encryptChunk: AES-256-GCM encryption of a single chunk
 * - decryptChunk: AES-256-GCM decryption of a single chunk
 */

const { parentPort } = require('worker_threads');
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive key using PBKDF2
 */
function deriveKey(password, salt, iterations = 100000) {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
}

/**
 * Encrypt a chunk with AES-256-GCM
 * Returns: { iv, authTag, encrypted }
 */
function encryptChunk(data, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, authTag, encrypted };
}

/**
 * Decrypt a chunk with AES-256-GCM
 */
function decryptChunk(encrypted, key, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// Handle messages from main thread
parentPort.on('message', (message) => {
  const { id, operation, data } = message;

  try {
    let result;

    switch (operation) {
      case 'deriveKey': {
        const { password, salt, iterations } = data;
        const key = deriveKey(
          Buffer.from(password),
          Buffer.from(salt),
          iterations || 100000
        );
        result = { key: key.toString('base64') };
        break;
      }

      case 'encryptChunk': {
        const { chunk, key } = data;
        const chunkBuffer = Buffer.from(chunk);
        const keyBuffer = Buffer.from(key, 'base64');
        const { iv, authTag, encrypted } = encryptChunk(chunkBuffer, keyBuffer);
        result = {
          iv: iv.toString('base64'),
          authTag: authTag.toString('base64'),
          encrypted: encrypted.toString('base64'),
        };
        break;
      }

      case 'decryptChunk': {
        const { encrypted, key, iv, authTag } = data;
        const decrypted = decryptChunk(
          Buffer.from(encrypted, 'base64'),
          Buffer.from(key, 'base64'),
          Buffer.from(iv, 'base64'),
          Buffer.from(authTag, 'base64')
        );
        result = { decrypted: decrypted.toString('base64') };
        break;
      }

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    parentPort.postMessage({ id, success: true, result });
  } catch (error) {
    parentPort.postMessage({ id, success: false, error: error.message });
  }
});

// Signal that worker is ready
parentPort.postMessage({ type: 'ready' });
