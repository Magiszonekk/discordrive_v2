import os from 'os';
import path from 'path';
import type { DiscordriveConfig, ResolvedConfig } from './types.js';

/** Default chunk size: ~8MB (safe for Discord's 25MB bot limit with overhead) */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024 - 1024;

/** Maximum file size: 10GB */
export const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

/** Default concurrent downloads */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 6;

/** Default batch size for uploads */
export const DEFAULT_UPLOAD_BATCH_SIZE = 3;

/** Default bots per channel */
export const DEFAULT_BOTS_PER_CHANNEL = 5;

/** Default bot init retries */
export const DEFAULT_BOT_INIT_RETRIES = 2;

/** PBKDF2 iterations */
export const PBKDF2_DEFAULT_ITERATIONS = 100_000;

/**
 * Resolve a partial config into a fully resolved config with defaults.
 */
export function resolveConfig(config: DiscordriveConfig): ResolvedConfig {
  return {
    discordTokens: config.discordTokens,
    channelIds: config.channelIds,
    dbPath: config.dbPath ?? './discordrive.db',
    botsPerChannel: config.botsPerChannel ?? DEFAULT_BOTS_PER_CHANNEL,
    chunkSize: config.chunkSize ?? DEFAULT_CHUNK_SIZE,
    batchSize: config.batchSize ?? DEFAULT_UPLOAD_BATCH_SIZE,
    downloadConcurrency: config.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY,
    encrypt: config.encrypt ?? true,
    encryptionKey: config.encryptionKey ?? null,
    publicBaseUrl: config.publicBaseUrl ?? '',
    tempDir: config.tempDir ?? path.join(os.tmpdir(), 'discordrive'),
    botInitRetries: config.botInitRetries ?? DEFAULT_BOT_INIT_RETRIES,
  };
}

/**
 * Read discordrive config from environment variables.
 * Follows the same convention as the backend's config/index.js.
 */
export function configFromEnv(): Partial<DiscordriveConfig> {
  const tokens = getDiscordTokensFromEnv();
  const channelIds = getDiscordChannelIdsFromEnv();

  const result: Partial<DiscordriveConfig> = {};

  if (tokens.length > 0) result.discordTokens = tokens;
  if (channelIds.length > 0) result.channelIds = channelIds;

  if (process.env.DISCORDRIVE_DB_PATH) result.dbPath = process.env.DISCORDRIVE_DB_PATH;
  if (process.env.BOTS_PER_CHANNEL) result.botsPerChannel = parseInt(process.env.BOTS_PER_CHANNEL, 10);
  if (process.env.CHUNK_SIZE) result.chunkSize = parseInt(process.env.CHUNK_SIZE, 10);
  if (process.env.UPLOAD_BATCH_SIZE) result.batchSize = parseInt(process.env.UPLOAD_BATCH_SIZE, 10);
  if (process.env.DOWNLOAD_CONCURRENCY) result.downloadConcurrency = parseInt(process.env.DOWNLOAD_CONCURRENCY, 10);
  if (process.env.BOT_INIT_RETRIES) result.botInitRetries = parseInt(process.env.BOT_INIT_RETRIES, 10);
  if (process.env.UPLOAD_TEMP_DIR) result.tempDir = process.env.UPLOAD_TEMP_DIR;
  if (process.env.DISCORDRIVE_PUBLIC_URL) result.publicBaseUrl = process.env.DISCORDRIVE_PUBLIC_URL;

  if (process.env.DISCORDRIVE_ENCRYPT !== undefined) {
    result.encrypt = process.env.DISCORDRIVE_ENCRYPT !== 'false' && process.env.DISCORDRIVE_ENCRYPT !== '0';
  }
  if (process.env.ENCRYPTION_KEY) result.encryptionKey = process.env.ENCRYPTION_KEY;

  return result;
}

function getDiscordTokensFromEnv(): string[] {
  const tokens: string[] = [];
  const entries = Object.entries(process.env)
    .filter(([key]) => /^DISCORD_TOKEN(_\d+)?$/.test(key))
    .map(([key, value]) => {
      const match = key.match(/^DISCORD_TOKEN(?:_(\d+))?$/);
      const num = match?.[1] ? parseInt(match[1], 10) : 1;
      return { value, num };
    })
    .sort((a, b) => a.num - b.num);

  for (const { value } of entries) {
    if (value && value.trim()) {
      tokens.push(value.trim());
    }
  }
  return tokens;
}

function getDiscordChannelIdsFromEnv(): string[] {
  const channels: string[] = [];
  const entries = Object.entries(process.env)
    .filter(([key]) => /^DISCORD_CHANNEL(_\d+)?_ID$/.test(key))
    .map(([key, value]) => {
      const match = key.match(/^DISCORD_CHANNEL(?:_(\d+))?_ID$/);
      const num = match?.[1] ? parseInt(match[1], 10) : 1;
      return { value, num };
    })
    .sort((a, b) => a.num - b.num);

  for (const { value } of entries) {
    if (value && value.trim()) {
      channels.push(value.trim());
    }
  }
  return channels;
}
