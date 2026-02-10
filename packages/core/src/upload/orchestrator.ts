import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import type {
  UploadOptions,
  UploadResult,
  ResolvedConfig,
  ChunkInput,
} from '../types.js';
import type { BotPool } from '../discord/bot-pool.js';
import type { DiscordriveDatabase } from '../db/database.js';
import { getPartFilename, guessMimeType } from '../utils/file.js';
import { encryptChunk, deriveKey, generateEncryptionHeader, generateSalt } from '../crypto/encrypt.js';

/**
 * Upload a file to Discord via the bot pool and record it in the database.
 *
 * Supports file path, Buffer, or Readable stream as input.
 */
export async function uploadFile(
  input: string | Buffer | Readable,
  options: UploadOptions,
  deps: { db: DiscordriveDatabase; botPool: BotPool; config: ResolvedConfig },
): Promise<UploadResult> {
  const { db, botPool, config } = deps;

  // 1. Resolve input to a Buffer (for now; streaming chunking can be added later)
  let buffer: Buffer;
  let filename: string;
  let fileSize: number;

  if (typeof input === 'string') {
    // File path
    const stat = await fs.promises.stat(input);
    fileSize = stat.size;
    filename = options.filename ?? path.basename(input);
    buffer = await fs.promises.readFile(input);
  } else if (Buffer.isBuffer(input)) {
    buffer = input;
    fileSize = buffer.length;
    filename = options.filename ?? 'file';
  } else {
    // Readable stream — collect into buffer
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
    fileSize = buffer.length;
    filename = options.filename ?? 'file';
  }

  const mimeType = options.mimeType ?? guessMimeType(filename);
  const chunkSize = config.chunkSize;
  const totalParts = Math.max(1, Math.ceil(fileSize / chunkSize));

  // 2. Determine encryption
  const shouldEncrypt = options.encrypt ?? config.encrypt;
  const encKey = options.encryptionKey ?? config.encryptionKey;

  if (shouldEncrypt && !encKey) {
    throw new Error('Encryption is enabled but no encryptionKey provided (in config or upload options)');
  }

  let encryptionHeader: string | null = null;
  let derivedKey: Buffer | null = null;
  let salt: Buffer | null = null;

  if (shouldEncrypt && encKey) {
    salt = generateSalt();
    derivedKey = await deriveKey(encKey, salt);
    encryptionHeader = generateEncryptionHeader(salt);

    options.onProgress?.({
      stage: 'encrypting',
      percent: 0,
      currentPart: 0,
      totalParts,
      bytesUploaded: 0,
      totalBytes: fileSize,
    });
  }

  // 3. Insert file record in DB
  const fileId = db.insertFile(filename, filename, fileSize, mimeType, totalParts, {
    folderId: options.folderId ?? null,
    encryptionHeader,
    userId: options.userId ?? null,
    mediaWidth: options.mediaWidth ?? null,
    mediaHeight: options.mediaHeight ?? null,
  });

  try {
    // 4. Chunk, optionally encrypt, and upload
    let bytesUploaded = 0;

    // Process in batches matching config.batchSize
    const allChunks: Array<{
      chunkInput: ChunkInput;
      iv: string | null;
      authTag: string | null;
      plainSize: number | null;
    }> = [];

    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const start = (partNumber - 1) * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      let chunk = buffer.subarray(start, end);

      let iv: string | null = null;
      let authTag: string | null = null;
      let plainSize: number | null = null;

      if (shouldEncrypt && derivedKey) {
        const encrypted = encryptChunk(chunk, derivedKey);
        chunk = encrypted.ciphertext;
        iv = Buffer.from(encrypted.iv).toString('base64');
        authTag = Buffer.from(encrypted.authTag).toString('base64');
        plainSize = encrypted.plainSize;
      }

      const partFilename = totalParts === 1
        ? filename
        : getPartFilename(filename, partNumber, totalParts);

      allChunks.push({
        chunkInput: { buffer: chunk, filename: partFilename, partIndex: partNumber },
        iv,
        authTag,
        plainSize,
      });
    }

    // Split into Discord message batches (config.batchSize chunks per message)
    const discordBatches: ChunkInput[][] = [];
    let batch: ChunkInput[] = [];
    for (const item of allChunks) {
      batch.push(item.chunkInput);
      if (batch.length >= config.batchSize) {
        discordBatches.push(batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      discordBatches.push(batch);
    }

    // Send all batches in parallel via bot pool
    options.onProgress?.({
      stage: 'uploading',
      percent: 0,
      currentPart: 0,
      totalParts,
      bytesUploaded: 0,
      totalBytes: fileSize,
    });

    const results = await botPool.sendFileBatchesParallel(discordBatches);

    // 5. Record results in DB
    for (const result of results) {
      const chunkMeta = allChunks.find(c => c.chunkInput.partIndex === result.partIndex);
      if (!chunkMeta) continue;

      db.insertFilePart(fileId, result.partIndex, result.messageId, result.url, result.size, {
        iv: chunkMeta.iv,
        authTag: chunkMeta.authTag,
        plainSize: chunkMeta.plainSize,
      });

      bytesUploaded += chunkMeta.chunkInput.buffer.length;

      options.onProgress?.({
        stage: 'uploading',
        percent: Math.round((bytesUploaded / fileSize) * 100),
        currentPart: result.partIndex,
        totalParts,
        bytesUploaded,
        totalBytes: fileSize,
      });
    }

    options.onProgress?.({
      stage: 'finalizing',
      percent: 100,
      currentPart: totalParts,
      totalParts,
      bytesUploaded: fileSize,
      totalBytes: fileSize,
    });

    return {
      fileId,
      filename,
      size: fileSize,
      mimeType,
      totalParts,
      encrypted: shouldEncrypt,
    };
  } catch (error) {
    // Cleanup on failure: delete DB record and Discord messages
    const file = db.getFileById(fileId);
    if (file?.parts && file.parts.length > 0) {
      const messageIds = [...new Set(file.parts.map(p => p.message_id).filter(Boolean))];
      if (messageIds.length > 0) {
        await botPool.deleteMessagesBulk(messageIds).catch(() => {});
      }
    }
    db.deleteFile(fileId);
    throw error;
  }
}
