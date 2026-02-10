const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { pipeline } = require('stream/promises');
const { config } = require('../config');

// Import shared logic from @discordrive/core
const {
  downloadPartsToFile,
  createDecryptionStream: coreCreateDecryptionStream,
} = require('@discordrive/core');

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

async function createDecryptionStream(tempFile, file, encryptionKey) {
  const key = encryptionKey || config.encryption.key;
  return coreCreateDecryptionStream(tempFile, file, key);
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
