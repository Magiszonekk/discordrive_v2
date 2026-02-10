import crypto from 'crypto';
import type { EncryptionHeader } from '../types.js';

/**
 * Parse an encryption header from JSON string.
 */
export function parseEncryptionHeader(headerString: string | null | undefined): EncryptionHeader | null {
  if (!headerString) return null;
  try {
    const parsed = typeof headerString === 'string' ? JSON.parse(headerString) : headerString;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/**
 * Check if header is the v2 chunked format.
 */
export function isChunkedHeader(header: any): boolean {
  if (!header) return false;
  return header.version === 'v2-chunked-aes-gcm' ||
    (typeof header.method === 'string' && header.method.startsWith('chunked-aes-gcm'));
}

/**
 * Parse an IV or auth_tag field from the database into a Buffer.
 * Supports: Buffer, number[], JSON array string, comma-separated numbers, base64 string.
 */
export function parseVectorField(value: any): Buffer {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || trimmed.startsWith('{')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return Buffer.from(arr);
      } catch {}
    }
    if (/^\d+(,\d+)*$/.test(trimmed)) {
      return Buffer.from(trimmed.split(',').map(n => parseInt(n, 10)));
    }
    try { return Buffer.from(trimmed, 'base64'); } catch { return Buffer.alloc(0); }
  }
  return Buffer.alloc(0);
}
