import crypto from 'crypto';
import { promisify } from 'util';
import fs from 'fs';
import { Readable, PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import type { FileRecord, ResolvedConfig } from '../types.js';
import { parseEncryptionHeader, isChunkedHeader, parseVectorField } from './utils.js';

const pbkdf2Async = promisify(crypto.pbkdf2);

// Legacy format constants (from utils/crypto.js)
const LEGACY_SALT_LENGTH = 32;
const LEGACY_IV_LENGTH = 16;
const LEGACY_AUTH_TAG_LENGTH = 16;
const LEGACY_HEADER_LENGTH = LEGACY_SALT_LENGTH + LEGACY_IV_LENGTH + LEGACY_AUTH_TAG_LENGTH;

/**
 * Create a decryption stream for a downloaded encrypted file.
 * Handles: v2 chunked, legacy single-header, and unencrypted (passthrough).
 */
export async function createDecryptionStream(
  tempFile: string,
  file: FileRecord,
  encryptionKey: string | null,
): Promise<{ stream: Readable }> {
  const header = parseEncryptionHeader(file.encryption_header);

  // Unencrypted file: just concatenate raw parts
  if (!header && !file.encryption_header) {
    const rawStream = fs.createReadStream(tempFile);
    return { stream: rawStream };
  }

  // v2 chunked format
  if (header && isChunkedHeader(header)) {
    const plainStream = await createChunkedDecryptStream(tempFile, file, header, encryptionKey!);
    return { stream: plainStream };
  }

  // Legacy single-header format
  if (!encryptionKey) throw new Error('Missing encryption key for decryption');

  const headerBuffer = Buffer.alloc(LEGACY_HEADER_LENGTH);
  const headerHandle = await fs.promises.open(tempFile, 'r');
  await headerHandle.read(headerBuffer, 0, LEGACY_HEADER_LENGTH, 0);
  await headerHandle.close();

  const salt = headerBuffer.subarray(0, LEGACY_SALT_LENGTH);
  const iv = headerBuffer.subarray(LEGACY_SALT_LENGTH, LEGACY_SALT_LENGTH + LEGACY_IV_LENGTH);
  const authTag = headerBuffer.subarray(LEGACY_SALT_LENGTH + LEGACY_IV_LENGTH, LEGACY_HEADER_LENGTH);

  const key = await pbkdf2Async(encryptionKey, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key as Buffer, iv);
  decipher.setAuthTag(authTag);

  const encryptedStream = fs.createReadStream(tempFile, { start: LEGACY_HEADER_LENGTH });
  const plainStream = new PassThrough();
  pipeline(encryptedStream, decipher, plainStream).catch((err) => plainStream.destroy(err));
  return { stream: plainStream };
}

export async function deriveKeyFromHeader(header: any, encryptionKey: string): Promise<Buffer> {
  const salt = parseVectorField(header.salt || header.saltBase64 || header.salt_hex || header.saltHex);
  const iterations = header.pbkdf2Iterations || header.pbkdf2 || 100000;
  if (!salt.length) throw new Error('Invalid encryption header salt');
  return pbkdf2Async(encryptionKey, salt, iterations, 32, 'sha256') as Promise<Buffer>;
}

async function createChunkedDecryptStream(
  tempFile: string,
  file: FileRecord,
  header: any,
  encryptionKey: string,
): Promise<Readable> {
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
