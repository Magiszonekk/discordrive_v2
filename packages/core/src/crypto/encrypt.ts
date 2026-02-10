import crypto from 'crypto';
import { promisify } from 'util';
import type { EncryptedChunk, EncryptionHeader } from '../types.js';

const pbkdf2Async = promisify(crypto.pbkdf2);

export const PBKDF2_ITERATIONS = 100_000;
export const IV_LENGTH = 12;  // GCM standard
export const TAG_LENGTH = 16;
export const SALT_LENGTH = 32;

/**
 * Derive a 256-bit key from a password using PBKDF2.
 */
export async function deriveKey(password: string, salt: Buffer, iterations: number = PBKDF2_ITERATIONS): Promise<Buffer> {
  return pbkdf2Async(password, salt, iterations, 32, 'sha256') as Promise<Buffer>;
}

/**
 * Encrypt a single chunk with AES-256-GCM.
 * Returns the ciphertext (including authTag appended), IV, authTag, and plainSize separately.
 */
export function encryptChunk(chunk: Buffer, key: Buffer): EncryptedChunk {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Ciphertext = encrypted data + authTag appended (this is how storageAssembler expects it)
  const ciphertext = Buffer.concat([encrypted, authTag]);
  return { ciphertext, iv, authTag, plainSize: chunk.length };
}

/**
 * Generate the encryption header JSON string for v2 chunked format.
 */
export function generateEncryptionHeader(salt: Buffer, iterations: number = PBKDF2_ITERATIONS): string {
  const header: EncryptionHeader = {
    version: 'v2-chunked-aes-gcm',
    salt: Array.from(salt),
    pbkdf2Iterations: iterations,
    ivLength: IV_LENGTH,
    tagLength: TAG_LENGTH,
  };
  return JSON.stringify(header);
}

/**
 * Generate a random salt for PBKDF2 key derivation.
 */
export function generateSalt(): Buffer {
  return crypto.randomBytes(SALT_LENGTH);
}
