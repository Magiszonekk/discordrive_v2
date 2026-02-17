import type { Readable } from 'stream';

// ==================== Config ====================

export interface DiscordriveConfig {
  /** Discord bot tokens (at least one required) */
  discordTokens: string[];
  /** Discord channel IDs for storage */
  channelIds: string[];
  /** Path to SQLite database file (default: './discordrive.db') */
  dbPath?: string;
  /** Bots assigned per channel for uploads (default: 5) */
  botsPerChannel?: number;
  /** Chunk size in bytes (default: ~8MB) */
  chunkSize?: number;
  /** Files per Discord message batch (default: 3) */
  batchSize?: number;
  /** Parallel downloads from Discord (default: 6) */
  downloadConcurrency?: number;
  /** Default encryption behavior (default: true) */
  encrypt?: boolean;
  /** Encryption key/password — required when encrypt is true */
  encryptionKey?: string;
  /** Base URL for constructing share links (e.g. "https://myapp.com/drive") */
  publicBaseUrl?: string;
  /** Temp directory for downloads (default: os.tmpdir()) */
  tempDir?: string;
  /** Bot initialization retry count (default: 2) */
  botInitRetries?: number;
}

export interface ResolvedConfig {
  discordTokens: string[];
  channelIds: string[];
  dbPath: string;
  botsPerChannel: number;
  chunkSize: number;
  batchSize: number;
  downloadConcurrency: number;
  encrypt: boolean;
  encryptionKey: string | null;
  publicBaseUrl: string;
  tempDir: string;
  botInitRetries: number;
}

// ==================== Bot Pool ====================

export interface BotPoolConfig {
  tokens: string[];
  channelIds: string[];
  botsPerChannel: number;
  botInitRetries: number;
  proxies?: string[];
  uploadChannelOverride?: string; // Force all bots to upload to this channel (multi-instance mode)
}

export interface Bot {
  client: any; // discord.js Client
  uploadChannel: any; // discord.js TextChannel
  allChannels: Map<string, any>;
  channel: any; // backward compat alias for uploadChannel
  busy: number;
  name: string;
  botIndex: number;
  uploadChannelId: string;
  proxyUrl?: string;
}

export interface ChunkInput {
  buffer: Buffer;
  filename: string;
  partIndex: number;
}

export interface UploadedChunk {
  messageId: string;
  url: string;
  size: number;
  partIndex: number;
  channelId: string;
}

// ==================== Database Records ====================

export interface FileRecord {
  id: number;
  name: string;
  original_name: string;
  size: number;
  mime_type: string | null;
  total_parts: number;
  folder_id: number | null;
  sort_order: number;
  encryption_header: string | null;
  created_at: string;
  op_password_hash: string | null;
  op_password_salt: string | null;
  uploader_ip: string | null;
  user_id: number | null;
  media_width: number | null;
  media_height: number | null;
  thumbnail_discord_url: string | null;
  thumbnail_message_id: string | null;
  thumbnail_iv: string | null;
  thumbnail_auth_tag: string | null;
  thumbnail_size: number | null;
  parts?: FilePartRecord[];
  /** Aggregated urls from JOIN (pipe-separated) */
  urls?: string;
  /** Aggregated message_ids from JOIN (pipe-separated) */
  message_ids?: string;
}

export interface FilePartRecord {
  id: number;
  file_id: number;
  part_number: number;
  message_id: string;
  discord_url: string;
  size: number;
  plain_size: number | null;
  iv: string | null;
  auth_tag: string | null;
  channel_id: string | null;
}

export interface FolderRecord {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
  op_password_hash: string | null;
  op_password_salt: string | null;
  user_id: number | null;
  file_count?: number;
}

export interface ShareRecord {
  id: number;
  token: string;
  file_id: number | null;
  folder_id: number | null;
  created_at: string;
  expires_at: string | null;
  access_count: number;
  encrypted_key: string | null;
  encrypted_key_salt: string | null;
  key_wrap_method: string | null;
  require_password: number;
  allow_insecure: number;
  url_key: string | null;
  media_width: number | null;
  media_height: number | null;
  allow_embed: number;
  // Joined fields
  file_name?: string | null;
  file_size?: number | null;
  file_mime_type?: string | null;
  folder_name?: string | null;
}

export interface InsertFileOptions {
  folderId?: number | null;
  encryptionHeader?: string | null;
  opPasswordHash?: string | null;
  opPasswordSalt?: string | null;
  uploaderIp?: string | null;
  userId?: number | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
}

export interface InsertFilePartExtra {
  plainSize?: number | null;
  iv?: string | null;
  authTag?: string | null;
  channelId?: string | null;
}

export interface CreateShareOptions {
  encryptedKey?: string | null;
  encryptedKeySalt?: string | null;
  keyWrapMethod?: string | null;
  requirePassword?: boolean;
  allowInsecure?: boolean;
  urlKey?: string | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  allowEmbed?: boolean;
}

export interface CreateFolderOptions {
  opPasswordHash?: string | null;
  opPasswordSalt?: string | null;
  userId?: number | null;
}

// ==================== Upload ====================

export interface UploadOptions {
  /** Custom filename (defaults to basename of file path) */
  filename?: string;
  /** MIME type override (auto-detected if omitted) */
  mimeType?: string;
  /** Target folder ID */
  folderId?: number;
  /** Media dimensions for video/image embeds */
  mediaWidth?: number;
  mediaHeight?: number;
  /** Override config default encryption per-upload */
  encrypt?: boolean;
  /** Override encryption key per-upload */
  encryptionKey?: string;
  /** User ID to associate with the upload */
  userId?: number | null;
  /** Progress callback */
  onProgress?: (progress: UploadProgress) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface UploadResult {
  fileId: number;
  filename: string;
  size: number;
  mimeType: string;
  totalParts: number;
  encrypted: boolean;
}

export interface UploadProgress {
  stage: 'reading' | 'encrypting' | 'uploading' | 'finalizing';
  percent: number;
  currentPart: number;
  totalParts: number;
  bytesUploaded: number;
  totalBytes: number;
}

// ==================== Download ====================

export interface DownloadOptions {
  encryptionKey?: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface DownloadProgress {
  completedParts: number;
  totalParts: number;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
}

// ==================== Share ====================

export interface ShareOptions {
  /** Make share accessible without password (embed key in URL) */
  allowInsecure?: boolean;
  /** Password to protect the share */
  password?: string;
  /** Enable Discord/social media embeds */
  allowEmbed?: boolean;
  /** Encryption key for wrapping (uses config key if not provided) */
  encryptionKey?: string;
  /** Expiration date */
  expiresAt?: Date;
  /** Media dimensions for embeds */
  mediaWidth?: number;
  mediaHeight?: number;
}

export interface ShareResult {
  id: number;
  token: string;
  url: string;
  downloadUrl: string;
  streamUrl: string;
  thumbUrl: string;
}

export interface UploadAndShareResult extends UploadResult {
  share: ShareResult;
}

// ==================== Encryption ====================

export interface EncryptedChunk {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  plainSize: number;
}

export interface EncryptionHeader {
  version: string;
  salt: number[];
  pbkdf2Iterations: number;
  ivLength: number;
  tagLength: number;
  [key: string]: unknown;
}

// ==================== Public API (re-exported for consumers) ====================

export interface FileItem {
  id: number;
  name: string;
  originalName: string;
  size: number;
  mimeType: string | null;
  totalParts: number;
  folderId: number | null;
  sortOrder: number;
  createdAt: string;
  encrypted: boolean;
  mediaWidth: number | null;
  mediaHeight: number | null;
}

export interface StatusInfo {
  botsReady: number;
  botsTotal: number;
  dbPath: string;
  encrypt: boolean;
}
