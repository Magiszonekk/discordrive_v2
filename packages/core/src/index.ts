import type { Readable } from 'stream';
import type {
  DiscordriveConfig,
  ResolvedConfig,
  UploadOptions,
  UploadResult,
  UploadAndShareResult,
  DownloadOptions,
  ShareOptions,
  ShareResult,
  FileItem,
  StatusInfo,
} from './types.js';
import { resolveConfig, configFromEnv } from './config.js';
import { BotPool } from './discord/bot-pool.js';
import { DiscordriveDatabase } from './db/database.js';
import { uploadFile } from './upload/orchestrator.js';
import { downloadFile, downloadStream } from './download/orchestrator.js';
import { createFileShare, createFolderShare } from './share/manager.js';
import { createShareRouter } from './share/middleware.js';

export class Discordrive {
  private botPool: BotPool;
  private db: DiscordriveDatabase;
  private config: ResolvedConfig;
  private initialized = false;

  constructor(config: DiscordriveConfig) {
    this.config = resolveConfig(config);
    this.db = new DiscordriveDatabase(this.config.dbPath);
    this.botPool = new BotPool({
      tokens: this.config.discordTokens,
      channelIds: this.config.channelIds,
      botsPerChannel: this.config.botsPerChannel,
      botInitRetries: this.config.botInitRetries,
    });
  }

  /**
   * Initialize Discord bots. Must be called before upload/delete operations.
   * Download and share operations work without init() if the database already has data.
   */
  async init(): Promise<void> {
    await this.botPool.init();
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Discordrive not initialized. Call init() first.');
    }
  }

  // ==================== Upload ====================

  /**
   * Upload a file from disk.
   */
  async upload(filePath: string, opts?: UploadOptions): Promise<UploadResult> {
    this.ensureInitialized();
    return uploadFile(filePath, opts ?? {}, {
      db: this.db,
      botPool: this.botPool,
      config: this.config,
    });
  }

  /**
   * Upload a Buffer.
   */
  async uploadBuffer(buf: Buffer, filename: string, opts?: UploadOptions): Promise<UploadResult> {
    this.ensureInitialized();
    return uploadFile(buf, { filename, ...opts }, {
      db: this.db,
      botPool: this.botPool,
      config: this.config,
    });
  }

  /**
   * Upload a Readable stream.
   */
  async uploadStream(stream: Readable, filename: string, opts?: UploadOptions): Promise<UploadResult> {
    this.ensureInitialized();
    return uploadFile(stream, { filename, ...opts }, {
      db: this.db,
      botPool: this.botPool,
      config: this.config,
    });
  }

  // ==================== Share ====================

  /**
   * Create a share link for a file.
   */
  async share(fileId: number, opts?: ShareOptions): Promise<ShareResult> {
    return createFileShare(fileId, { db: this.db, config: this.config }, opts);
  }

  /**
   * Create a share link for a folder.
   */
  async shareFolder(folderId: number, opts?: ShareOptions): Promise<ShareResult> {
    return createFolderShare(folderId, { db: this.db, config: this.config }, opts);
  }

  /**
   * Upload a file and immediately create a share link.
   * This is the most common use case for library consumers.
   */
  async uploadAndShare(
    input: string | Buffer | Readable,
    opts?: UploadOptions & ShareOptions & { filename?: string },
  ): Promise<UploadAndShareResult> {
    this.ensureInitialized();
    const uploadResult = await uploadFile(input, opts ?? {}, {
      db: this.db,
      botPool: this.botPool,
      config: this.config,
    });

    const shareResult = await createFileShare(
      uploadResult.fileId,
      { db: this.db, config: this.config },
      {
        allowInsecure: opts?.allowInsecure,
        allowEmbed: opts?.allowEmbed,
        password: opts?.password,
        encryptionKey: opts?.encryptionKey ?? this.config.encryptionKey ?? undefined,
        expiresAt: opts?.expiresAt,
        mediaWidth: opts?.mediaWidth,
        mediaHeight: opts?.mediaHeight,
      },
    );

    return { ...uploadResult, share: shareResult };
  }

  // ==================== Download ====================

  /**
   * Download a file to disk (decrypted).
   */
  async download(fileId: number, destPath: string, opts?: DownloadOptions): Promise<void> {
    return downloadFile(fileId, destPath, { db: this.db, config: this.config }, opts);
  }

  /**
   * Download a file as a Readable stream (decrypted).
   */
  async downloadStream(fileId: number, opts?: DownloadOptions): Promise<Readable> {
    return downloadStream(fileId, { db: this.db, config: this.config }, opts);
  }

  // ==================== Delete ====================

  /**
   * Delete a file from the database and Discord.
   */
  async delete(fileId: number): Promise<void> {
    this.ensureInitialized();
    const file = this.db.getFileById(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);

    // Delete Discord messages
    if (file.parts && file.parts.length > 0) {
      const messageIds = [...new Set(file.parts.map(p => p.message_id).filter(Boolean))];
      if (messageIds.length > 0) {
        await this.botPool.deleteMessagesBulk(messageIds);
      }
    }

    // Delete thumbnail message if present
    if (file.thumbnail_message_id) {
      await this.botPool.deleteMessage(file.thumbnail_message_id).catch(() => {});
    }

    // Delete DB record (cascades to file_parts and shares)
    this.db.deleteFile(fileId);
  }

  // ==================== List ====================

  /**
   * List files, optionally filtered by folder.
   */
  list(folderId?: number | null, userId?: number | null): FileItem[] {
    const files = this.db.getAllFiles(folderId, userId);
    return files.map(f => ({
      id: f.id,
      name: f.name,
      originalName: f.original_name,
      size: f.size,
      mimeType: f.mime_type,
      totalParts: f.total_parts,
      folderId: f.folder_id,
      sortOrder: f.sort_order,
      createdAt: f.created_at,
      encrypted: !!f.encryption_header,
      mediaWidth: f.media_width,
      mediaHeight: f.media_height,
    }));
  }

  // ==================== Express Middleware ====================

  /**
   * Returns an Express router that serves share URLs.
   *
   * Usage:
   * ```ts
   * app.use('/drive', drive.middleware());
   * // Share URLs will be served at /drive/s/:token
   * ```
   */
  middleware(): any {
    return createShareRouter({ db: this.db, config: this.config });
  }

  // ==================== Status & Lifecycle ====================

  /**
   * Get current status.
   */
  status(): StatusInfo {
    return {
      botsReady: this.botPool.getBotCount(),
      botsTotal: this.config.discordTokens.length,
      dbPath: this.config.dbPath,
      encrypt: this.config.encrypt,
    };
  }

  /**
   * Access the underlying database instance for advanced operations.
   */
  getDatabase(): DiscordriveDatabase {
    return this.db;
  }

  /**
   * Access the underlying bot pool for advanced operations.
   */
  getBotPool(): BotPool {
    return this.botPool;
  }

  /**
   * Destroy all Discord bot connections and close the database.
   */
  async destroy(): Promise<void> {
    await this.botPool.destroy();
    this.db.close();
    this.initialized = false;
  }

  /**
   * Read config from environment variables.
   * Convenience static method for quick setup.
   *
   * ```ts
   * const drive = new Discordrive({
   *   ...Discordrive.configFromEnv(),
   *   dbPath: './my-project.db',
   * });
   * ```
   */
  static configFromEnv = configFromEnv;
}

// ==================== Re-exports ====================

// Main class
export { Discordrive as default };

// Config
export { resolveConfig, configFromEnv } from './config.js';

// Sub-components (for advanced use)
export { BotPool } from './discord/bot-pool.js';
export { DiscordriveDatabase } from './db/database.js';

// Orchestrators
export { uploadFile } from './upload/orchestrator.js';
export { downloadFile, downloadStream } from './download/orchestrator.js';
export { downloadPartsToFile } from './download/part-downloader.js';

// Share
export { createFileShare, createFolderShare } from './share/manager.js';
export { createShareRouter } from './share/middleware.js';

// Crypto
export { deriveKey, encryptChunk, generateEncryptionHeader, generateSalt } from './crypto/encrypt.js';
export { createDecryptionStream } from './crypto/decrypt.js';
export { parseEncryptionHeader, isChunkedHeader, parseVectorField } from './crypto/utils.js';

// Utilities
export { withRetry } from './utils/retry.js';
export { getPartFilename, formatFileSize, guessMimeType } from './utils/file.js';

// Types
export type {
  DiscordriveConfig,
  ResolvedConfig,
  BotPoolConfig,
  Bot,
  ChunkInput,
  UploadedChunk,
  FileRecord,
  FilePartRecord,
  FolderRecord,
  ShareRecord,
  InsertFileOptions,
  InsertFilePartExtra,
  CreateShareOptions,
  CreateFolderOptions,
  UploadOptions,
  UploadResult,
  UploadProgress,
  DownloadOptions,
  DownloadProgress,
  ShareOptions,
  ShareResult,
  UploadAndShareResult,
  EncryptedChunk,
  EncryptionHeader,
  FileItem,
  StatusInfo,
} from './types.js';
