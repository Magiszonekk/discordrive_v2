import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { DownloadOptions, ResolvedConfig, FileRecord } from '../types.js';
import type { DiscordriveDatabase } from '../db/database.js';
import { downloadPartsToFile } from './part-downloader.js';
import { createDecryptionStream } from '../crypto/decrypt.js';

/**
 * Download a file to disk (decrypted).
 */
export async function downloadFile(
  fileId: number,
  destPath: string,
  deps: { db: DiscordriveDatabase; config: ResolvedConfig },
  options?: DownloadOptions,
): Promise<void> {
  const stream = await downloadStream(fileId, deps, options);
  const writeStream = fs.createWriteStream(destPath);
  await pipeline(stream, writeStream);
}

/**
 * Download a file as a readable stream (decrypted).
 */
export async function downloadStream(
  fileId: number,
  deps: { db: DiscordriveDatabase; config: ResolvedConfig },
  options?: DownloadOptions,
): Promise<Readable> {
  const { db, config } = deps;

  const file = db.getFileById(fileId);
  if (!file) throw new Error(`File not found: ${fileId}`);
  if (!file.parts || file.parts.length === 0) throw new Error(`File has no parts: ${fileId}`);

  const encryptionKey = options?.encryptionKey ?? config.encryptionKey;
  const isEncrypted = !!file.encryption_header;

  if (isEncrypted && !encryptionKey) {
    throw new Error('File is encrypted but no encryptionKey provided');
  }

  // Ensure temp directory exists
  await fs.promises.mkdir(config.tempDir, { recursive: true });

  const tempFile = path.join(
    config.tempDir,
    `download-${file.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.enc`,
  );

  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    // Pre-allocate temp file and download all parts
    const totalEncryptedSize = file.parts.reduce((sum, p) => sum + p.size, 0);
    fileHandle = await fs.promises.open(tempFile, 'w');
    await fileHandle.truncate(totalEncryptedSize);

    await downloadPartsToFile(
      file.parts,
      fileHandle,
      config.chunkSize,
      config.downloadConcurrency,
      (completed, total, bytesDownloaded, totalBytes) => {
        options?.onProgress?.({
          completedParts: completed,
          totalParts: total,
          bytesDownloaded,
          totalBytes,
          percent: Math.round((completed / Math.max(total, 1)) * 100),
        });
      },
      options?.signal,
    );

    await fileHandle.close();
    fileHandle = null;

    // Create decryption stream (handles encrypted, chunked, and unencrypted)
    const { stream } = await createDecryptionStream(tempFile, file, encryptionKey);

    // Cleanup temp file after stream is consumed
    stream.on('end', () => {
      fs.promises.unlink(tempFile).catch(() => {});
    });
    stream.on('error', () => {
      fs.promises.unlink(tempFile).catch(() => {});
    });

    return stream;
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {});
    await fs.promises.unlink(tempFile).catch(() => {});
    throw error;
  }
}
