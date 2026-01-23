const fs = require('fs');
const path = require('path');
const { PassThrough, Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { config } = require('../config');
const { downloadPartsToFile } = require('./partDownloader');
const { createDecipherFromHeaderAsync, HEADER_LENGTH } = require('../utils/crypto');
const crypto = require('crypto');
const { promisify } = require('util');

const pbkdf2Async = promisify(crypto.pbkdf2);

function parseEncryptionHeader(headerString) {
  if (!headerString) return null;
  try {
    const parsed = typeof headerString === 'string' ? JSON.parse(headerString) : headerString;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isChunkedHeader(header) {
  if (!header) return false;
  return (
    header.version === 'v2-chunked-aes-gcm' ||
    (typeof header.method === 'string' && header.method.startsWith('chunked-aes-gcm'))
  );
}

function parseVectorField(value) {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Try JSON array
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || trimmed.startsWith('{')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return Buffer.from(arr);
      } catch {
        /* ignore */
      }
    }
    // Comma-separated numbers
    if (/^\d+(,\d+)*$/.test(trimmed)) {
      return Buffer.from(trimmed.split(',').map((n) => parseInt(n, 10)));
    }
    // Base64 fallback
    try {
      return Buffer.from(trimmed, 'base64');
    } catch {
      return Buffer.alloc(0);
    }
  }
  return Buffer.alloc(0);
}

async function downloadEncryptedFileToTemp(file, prefix = 'download', onProgress) {
  await fs.promises.mkdir(config.upload.tempDir, { recursive: true });
  const tempFile = path.join(
    config.upload.tempDir,
    `${prefix}-${file.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.enc`
  );

  let fileHandle = null;
  try {
    fileHandle = await fs.promises.open(tempFile, 'w');
    const totalEncryptedSize = file.parts.reduce((sum, part) => sum + part.size, 0);
    await fileHandle.truncate(totalEncryptedSize);
    await downloadPartsToFile(
      file.parts,
      fileHandle,
      config.upload.chunkSize,
      config.download.concurrency,
      (completed, total) => {
        if (typeof onProgress === 'function') {
          const percent = Math.round((completed / Math.max(total, 1)) * 100);
          onProgress({ completedParts: completed, totalParts: total, percent });
        }
      }
    );
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }

  return tempFile;
}

async function deriveKeyFromHeader(header, encryptionKey) {
  const password = encryptionKey || config.encryption.key;
  if (!password) {
    throw new Error('Missing encryption key for decryption');
  }
  const salt = parseVectorField(header.salt || header.saltBase64 || header.salt_hex || header.saltHex);
  const iterations = header.pbkdf2Iterations || header.pbkdf2 || 100000;
  if (!salt.length) {
    throw new Error('Invalid encryption header salt');
  }
  return pbkdf2Async(password, salt, iterations, 32, 'sha256');
}

async function createChunkedDecryptStream(tempFile, file, header, encryptionKey) {
  const key = await deriveKeyFromHeader(header, encryptionKey);
  const ivLength = header.ivLength || 12;
  const tagLength = header.tagLength || 16;

  const fileHandle = await fs.promises.open(tempFile, 'r');
  let offset = 0;

  async function* generator() {
    try {
      for (const part of file.parts || []) {
        const partSize = part.size;
        if (!partSize) continue;
        const buffer = Buffer.alloc(partSize);
        await fileHandle.read(buffer, 0, partSize, offset);
        offset += partSize;

        const iv = parseVectorField(part.iv);
        const storedTag = parseVectorField(part.auth_tag);
        const effectiveTagLength = storedTag.length || tagLength;
        const cipherText = buffer.subarray(0, buffer.length - effectiveTagLength);
        const tag = storedTag.length ? storedTag : buffer.subarray(buffer.length - effectiveTagLength);

        if (iv.length !== ivLength) {
          throw new Error(`Invalid IV length for part ${part.part_number || ''}`);
        }

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        yield decrypted;
      }
    } finally {
      await fileHandle.close().catch(() => {});
    }
  }

  return Readable.from(generator());
}

async function createDecryptionStream(tempFile, file, encryptionKey) {
  const header = parseEncryptionHeader(file?.encryption_header);

  // New chunked format: decrypt each part separately
  if (header && isChunkedHeader(header)) {
    const plainStream = await createChunkedDecryptStream(tempFile, file, header, encryptionKey);
    return { stream: plainStream };
  }

  // Legacy single-header format: use v1 header + decipher stream
  const headerBuffer = Buffer.alloc(HEADER_LENGTH);
  const headerHandle = await fs.promises.open(tempFile, 'r');
  await headerHandle.read(headerBuffer, 0, HEADER_LENGTH, 0);
  await headerHandle.close();

  const keyForDecipher = encryptionKey || config.encryption.key;
  if (!keyForDecipher) {
    throw new Error('Missing encryption key for decryption');
  }
  const decipher = await createDecipherFromHeaderAsync(headerBuffer, keyForDecipher);
  const encryptedStream = fs.createReadStream(tempFile, { start: HEADER_LENGTH });
  const plainStream = new PassThrough();
  pipeline(encryptedStream, decipher, plainStream).catch((err) => plainStream.destroy(err));
  return { stream: plainStream };
}

async function withDecryptedFileStream(file, handler, options = {}) {
  const prefix = options.prefix || 'download';
  const tempFile = await downloadEncryptedFileToTemp(file, prefix, options.onProgress);
  try {
    const { stream } = await createDecryptionStream(tempFile, file, options.encryptionKey);
    await handler(stream, { tempFile });
  } finally {
    await fs.promises.unlink(tempFile).catch(() => {});
  }
}

async function appendFileToArchive(file, archive, options = {}) {
  const entryName = options.entryName || file.original_name;
  await withDecryptedFileStream(
    file,
    async (plainStream) => {
      const passThrough = new PassThrough();
      archive.append(passThrough, { name: entryName });
      await pipeline(plainStream, passThrough);
    },
    {
      prefix: options.prefix || 'download',
      onProgress: options.onProgress,
      encryptionKey: options.encryptionKey,
    }
  );
}

module.exports = {
  downloadEncryptedFileToTemp,
  createDecryptionStream,
  withDecryptedFileStream,
  appendFileToArchive,
};
