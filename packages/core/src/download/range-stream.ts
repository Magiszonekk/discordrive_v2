import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import type { FileRecord, FilePartRecord, ResolvedConfig } from '../types.js';
import type { BotPool } from '../discord/bot-pool.js';
import type { DiscordriveDatabase } from '../db/database.js';
import { parseEncryptionHeader, isChunkedHeader, parseVectorField } from '../crypto/utils.js';
import { deriveKeyFromHeader } from '../crypto/decrypt.js';
import { downloadPartsToFile } from './part-downloader.js';
import { resolvePartUrls } from './url-resolver.js';

export interface ChunkRange {
  /** Index into file.parts[] for the first needed part */
  firstPartIndex: number;
  /** Index into file.parts[] for the last needed part */
  lastPartIndex: number;
  /** Byte offset to skip within the first decrypted chunk */
  offsetInFirstChunk: number;
  /** How many bytes to take from the last decrypted chunk */
  bytesFromLastChunk: number;
  /** Total plain bytes in the response */
  contentLength: number;
}

/**
 * Given a byte range in plaintext space, determine which encrypted parts are needed
 * and how to slice the decrypted output.
 */
export function calculateChunkRange(
  rangeStart: number,
  rangeEnd: number,
  chunkSize: number,
  parts: FilePartRecord[],
): ChunkRange {
  // Build a map of cumulative plain offsets per part
  let cumulativePlain = 0;
  const partOffsets: { start: number; end: number; plainSize: number }[] = [];

  for (const part of parts) {
    const plainSize = part.plain_size ?? chunkSize;
    partOffsets.push({
      start: cumulativePlain,
      end: cumulativePlain + plainSize - 1,
      plainSize,
    });
    cumulativePlain += plainSize;
  }

  // Find first and last part indices that overlap with [rangeStart, rangeEnd]
  let firstPartIndex = -1;
  let lastPartIndex = -1;

  for (let i = 0; i < partOffsets.length; i++) {
    if (partOffsets[i].end >= rangeStart && firstPartIndex === -1) {
      firstPartIndex = i;
    }
    if (partOffsets[i].start <= rangeEnd) {
      lastPartIndex = i;
    }
  }

  if (firstPartIndex === -1 || lastPartIndex === -1) {
    throw new Error('Range is outside file boundaries');
  }

  const offsetInFirstChunk = rangeStart - partOffsets[firstPartIndex].start;
  const endInLastChunk = rangeEnd - partOffsets[lastPartIndex].start;
  const bytesFromLastChunk = endInLastChunk + 1;
  const contentLength = rangeEnd - rangeStart + 1;

  return {
    firstPartIndex,
    lastPartIndex,
    offsetInFirstChunk,
    bytesFromLastChunk,
    contentLength,
  };
}

/**
 * Download and decrypt only the parts needed for a byte range.
 * Returns a Readable stream of exactly the requested bytes.
 */
export async function downloadRangeStream(
  file: FileRecord,
  rangeStart: number,
  rangeEnd: number,
  config: ResolvedConfig,
  encryptionKey: string | null,
  botPool?: BotPool,
  db?: DiscordriveDatabase,
): Promise<Readable> {
  let parts = file.parts || [];
  if (parts.length === 0) throw new Error('File has no parts');

  // Resolve fresh Discord URLs if botPool is available
  if (botPool) {
    parts = await resolvePartUrls(parts, botPool, db);
  }

  const range = calculateChunkRange(rangeStart, rangeEnd, config.chunkSize, parts);
  const neededParts = parts.slice(range.firstPartIndex, range.lastPartIndex + 1);

  const header = parseEncryptionHeader(file.encryption_header);
  const isEncrypted = !!header && isChunkedHeader(header);

  // Download only the needed parts to a temp file
  const tempDir = config.tempDir || path.join(os.tmpdir(), 'discordrive');
  await fs.promises.mkdir(tempDir, { recursive: true });
  const tempFile = path.join(
    tempDir,
    `range-${file.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.enc`,
  );

  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    const totalEncSize = neededParts.reduce((sum, p) => sum + p.size, 0);
    fileHandle = await fs.promises.open(tempFile, 'w');
    await fileHandle.truncate(totalEncSize);

    // Remap part_numbers to sequential offsets for the temp file
    const remappedParts = neededParts.map((p, i) => ({
      ...p,
      _originalPartNumber: p.part_number,
      part_number: i + 1,
    }));

    await downloadPartsToFile(
      remappedParts,
      fileHandle,
      // Use max encrypted part size as chunk size so offsets are calculated correctly
      Math.max(...neededParts.map(p => p.size)),
      config.downloadConcurrency,
    );

    await fileHandle.close();
    fileHandle = null;

    // Decrypt and slice
    let resultBuffer: Buffer;

    if (isEncrypted && encryptionKey) {
      const key = await deriveKeyFromHeader(header, encryptionKey);
      const ivLength = header.ivLength || 12;
      const tagLength = header.tagLength || 16;

      const fh = await fs.promises.open(tempFile, 'r');
      const decryptedChunks: Buffer[] = [];
      let offset = 0;

      try {
        for (const part of neededParts) {
          const partSize = part.size;
          if (!partSize) continue;
          const buffer = Buffer.alloc(partSize);
          await fh.read(buffer, 0, partSize, offset);
          offset += partSize;

          const iv = parseVectorField(part.iv);
          const storedTag = parseVectorField(part.auth_tag);
          const effectiveTagLength = storedTag.length || tagLength;
          const cipherText = buffer.subarray(0, buffer.length - effectiveTagLength);
          const tag = storedTag.length
            ? storedTag
            : buffer.subarray(buffer.length - effectiveTagLength);

          if (iv.length !== ivLength) {
            throw new Error(`Invalid IV length for part ${part.part_number}`);
          }

          const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          decryptedChunks.push(Buffer.concat([decipher.update(cipherText), decipher.final()]));
        }
      } finally {
        await fh.close().catch(() => {});
      }

      const fullPlain = Buffer.concat(decryptedChunks);
      resultBuffer = fullPlain.subarray(range.offsetInFirstChunk, range.offsetInFirstChunk + range.contentLength);
    } else {
      // Unencrypted: just read and slice
      const fh = await fs.promises.open(tempFile, 'r');
      const chunks: Buffer[] = [];
      let offset = 0;
      try {
        for (const part of neededParts) {
          const sz = part.plain_size ?? part.size;
          const buf = Buffer.alloc(sz);
          await fh.read(buf, 0, sz, offset);
          offset += part.size;
          chunks.push(buf);
        }
      } finally {
        await fh.close().catch(() => {});
      }
      const fullPlain = Buffer.concat(chunks);
      resultBuffer = fullPlain.subarray(range.offsetInFirstChunk, range.offsetInFirstChunk + range.contentLength);
    }

    // Cleanup temp file
    await fs.promises.unlink(tempFile).catch(() => {});

    return Readable.from([resultBuffer]);
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {});
    await fs.promises.unlink(tempFile).catch(() => {});
    throw error;
  }
}
