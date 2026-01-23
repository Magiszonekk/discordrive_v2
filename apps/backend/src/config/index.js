const path = require('path');

// Load .env from monorepo root (2 levels up from apps/backend/src)
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '..', '.env') });

// Data directory is in apps/backend/data
const projectTempDir = path.resolve(__dirname, '..', '..', 'data', 'temp');

// Parse multiple Discord tokens from env (DISCORD_TOKEN, DISCORD_TOKEN_2, DISCORD_TOKEN_3, etc.)
// Supports unlimited number of bots - just add DISCORD_TOKEN_N to .env
function getDiscordTokens() {
  const tokens = [];

  // Find all DISCORD_TOKEN* environment variables
  const tokenEntries = Object.entries(process.env)
    .filter(([key]) => /^DISCORD_TOKEN(_\d+)?$/.test(key))
    .map(([key, value]) => {
      // Extract number for sorting (DISCORD_TOKEN = 1, DISCORD_TOKEN_2 = 2, etc.)
      const match = key.match(/^DISCORD_TOKEN(?:_(\d+))?$/);
      const num = match[1] ? parseInt(match[1], 10) : 1;
      return { key, value, num };
    })
    .sort((a, b) => a.num - b.num);

  for (const { value } of tokenEntries) {
    if (value && value.trim()) {
      tokens.push(value.trim());
    }
  }

  return tokens;
}

// Parse multiple Discord channel IDs from env (DISCORD_CHANNEL_ID, DISCORD_CHANNEL_2_ID, etc.)
function getDiscordChannelIds() {
  const channels = [];

  // Find all DISCORD_CHANNEL*_ID environment variables
  const channelEntries = Object.entries(process.env)
    .filter(([key]) => /^DISCORD_CHANNEL(_\d+)?_ID$/.test(key))
    .map(([key, value]) => {
      // Extract number for sorting (DISCORD_CHANNEL_ID = 1, DISCORD_CHANNEL_2_ID = 2, etc.)
      const match = key.match(/^DISCORD_CHANNEL(?:_(\d+))?_ID$/);
      const num = match[1] ? parseInt(match[1], 10) : 1;
      return { key, value, num };
    })
    .sort((a, b) => a.num - b.num);

  for (const { value } of channelEntries) {
    if (value && value.trim()) {
      channels.push(value.trim());
    }
  }

  return channels;
}

// Default chunk size: ~8MB (safe for Discord's 25MB bot limit with overhead)
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024 - 1024;

const config = {
  discord: {
    tokens: getDiscordTokens(),
    token: process.env.DISCORD_TOKEN, // Keep for backward compatibility
    channelId: process.env.DISCORD_CHANNEL_ID, // Primary channel (backward compat)
    channelIds: getDiscordChannelIds(), // All channels for multi-channel support
    botsPerChannel: parseInt(process.env.BOTS_PER_CHANNEL, 10) || 5, // Bots assigned per channel for uploads
    botInitRetries: parseInt(process.env.BOT_INIT_RETRIES, 10) || 2,
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || 'localhost',
    legacyFrontendPort: parseInt(process.env.LEGACY_FRONTEND_PORT, 10) || 3001,
    jwtSecret: process.env.JWT_SECRET || 'changeme',
  },
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024 * 1024, // Default 10GB
    // Configurable chunk size (default ~8MB, safe for Discord's 25MB bot limit)
    chunkSize: parseInt(process.env.CHUNK_SIZE, 10) || DEFAULT_CHUNK_SIZE,
    tempDir: process.env.UPLOAD_TEMP_DIR || projectTempDir,
    batchSize: parseInt(process.env.UPLOAD_BATCH_SIZE, 10) || 3, // Files per Discord message
    // Aggressive mode: skip ramp-up, use max parallelism immediately (for performance testing only!)
    aggressiveMode: process.env.UPLOAD_AGGRESSIVE_MODE === 'true',
  },
  download: {
    concurrency: parseInt(process.env.DOWNLOAD_CONCURRENCY, 10) || 6, // Parallel chunk downloads
  },
  db: {
    path: path.resolve(__dirname, '..', '..', 'data', 'discordrive.db'),
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY,
    enabled: !!process.env.ENCRYPTION_KEY,
  },
};

// Validate required config
function validateConfig() {
  const errors = [];
  if (!config.discord.token) errors.push('DISCORD_TOKEN is required');
  if (!config.discord.channelId) errors.push('DISCORD_CHANNEL_ID is required');

  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(err => console.error(`  - ${err}`));
    console.error('\nCopy .env.example to .env and fill in your values.');
    process.exit(1);
  }

  if (config.encryption.enabled) {
    console.log('Encryption: ENABLED (AES-256-GCM)');
  } else {
    console.log('Encryption key not provided; server-side crypto disabled (client must supply key).');
  }
}

module.exports = { config, validateConfig };
