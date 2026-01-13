const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const { config } = require('../config');

// Bot pool - array of { client, uploadChannel, allChannels, busy, name, botIndex }
// uploadChannel = channel assigned for uploads (based on bot index)
// allChannels = Map of channelId -> channel (for downloads from any channel)
let botPool = [];
let currentBotIndex = 0;

// All channel IDs for reference
let allChannelIds = [];

// Retry configuration for rate limiting
const RETRY_CONFIG = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff for Discord API calls
 */
async function withRetry(operation, operationName = 'operation') {
  let lastError;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if it's a rate limit error (Discord.js throws with code or status)
      const isRateLimit =
        error.status === 429 ||
        error.code === 429 ||
        error.httpStatus === 429 ||
        (error.message && error.message.toLowerCase().includes('rate limit'));

      // Also retry on network errors
      const isNetworkError =
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.message?.includes('getaddrinfo') ||
        error.message?.includes('socket hang up');

      if (!isRateLimit && !isNetworkError) {
        // Not a retryable error, throw immediately
        throw error;
      }

      if (attempt === RETRY_CONFIG.maxRetries) {
        console.error(`[Discord] ${operationName} failed after ${RETRY_CONFIG.maxRetries} attempts`);
        throw error;
      }

      // Calculate delay with exponential backoff + jitter
      let delay = RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1);

      // If Discord provides retry-after, use it
      if (error.retryAfter) {
        delay = Math.max(delay, error.retryAfter * 1000);
      }

      // Add jitter (±20%)
      delay = delay * (0.8 + Math.random() * 0.4);
      delay = Math.min(delay, RETRY_CONFIG.maxDelayMs);

      console.warn(`[Discord] ${operationName} failed (attempt ${attempt}/${RETRY_CONFIG.maxRetries}), ` +
        `retrying in ${Math.round(delay)}ms... Error: ${error.message}`);

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Get channel ID for a bot based on its index
 * Bots are distributed across channels: first N bots -> channel 1, next N -> channel 2, etc.
 */
function getUploadChannelIdForBot(botIndex) {
  const channelIds = config.discord.channelIds;
  const botsPerChannel = config.discord.botsPerChannel;

  if (channelIds.length === 0) {
    // Fallback to single channel
    return config.discord.channelId;
  }

  // Calculate which channel this bot should use for uploads
  const channelIndex = Math.floor(botIndex / botsPerChannel);
  // Clamp to available channels (extra bots go to last channel)
  const effectiveChannelIndex = Math.min(channelIndex, channelIds.length - 1);

  return channelIds[effectiveChannelIndex];
}

/**
 * Initialize a single Discord bot
 * Each bot gets an upload channel assigned, but fetches ALL channels for downloads
 */
async function initBot(token, index) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  try {
    await client.login(token);
  } catch (err) {
    throw new Error(`Login failed for bot ${index + 1}: ${err.message || err}`);
  }

  // Wait for client to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discord client ready timeout')), 20000);
    const onReady = () => {
      clearTimeout(timeout);
      resolve();
    };
    client.once('clientReady', onReady);
    client.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Determine upload channel for this bot
  const uploadChannelId = getUploadChannelIdForBot(index);

  // Fetch all channels (for downloads) and the upload channel
  const channelIds = config.discord.channelIds.length > 0
    ? config.discord.channelIds
    : [config.discord.channelId];

  const allChannels = new Map();
  let uploadChannel = null;

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel) {
        allChannels.set(channelId, channel);
        if (channelId === uploadChannelId) {
          uploadChannel = channel;
        }
      }
    } catch (err) {
      console.warn(`[Discord] Bot ${index + 1} failed to fetch channel ${channelId}: ${err.message}`);
    }
  }

  if (!uploadChannel) {
    throw new Error(`Upload channel ${uploadChannelId} not found for bot ${index + 1}`);
  }

  return {
    client,
    uploadChannel,      // Channel for uploads (assigned based on bot index)
    allChannels,        // All channels (for downloads)
    channel: uploadChannel, // Backward compatibility
    busy: 0,
    name: `Bot-${index + 1} (${client.user.tag})`,
    botIndex: index,
    uploadChannelId,
  };
}

// Track initialization state
let totalConfiguredBots = 0;
let botsInitialized = 0;
let botsFailed = 0;
let initializationComplete = false;

/**
 * Initialize all Discord bots from config (async, non-blocking)
 * Bots load in the background - server doesn't wait for all of them
 */
async function initDiscord() {
  const tokens = config.discord.tokens;

  if (!tokens || tokens.length === 0) {
    throw new Error('No Discord tokens configured');
  }

  // Store all channel IDs for reference
  allChannelIds = config.discord.channelIds.length > 0
    ? config.discord.channelIds
    : [config.discord.channelId];

  totalConfiguredBots = tokens.length;
  const channelCount = allChannelIds.length;
  const botsPerChannel = config.discord.botsPerChannel;

  console.log(`[Discord] Starting asynchronous initialization of ${tokens.length} bot(s)...`);
  console.log(`[Discord] Multi-channel mode: ${channelCount} channel(s), ${botsPerChannel} bots per channel`);
  for (let i = 0; i < allChannelIds.length; i++) {
    const startBot = i * botsPerChannel + 1;
    const endBot = Math.min((i + 1) * botsPerChannel, tokens.length);
    console.log(`[Discord]   Channel ${i + 1} (${allChannelIds[i]}): Bots ${startBot}-${endBot}`);
  }

  // Start loading bots fully in background (non-blocking)
  loadBotsInBackground(tokens);

  // Immediately return; server startup no longer waits for a bot
  return { client: null, channel: null };
}

/**
 * Load bots in background (non-blocking) with retry support
 */
async function loadBotsInBackground(tokens) {
  const maxRetries = config.discord.botInitRetries;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    // Start bot initialization with retry logic
    initBotWithRetry(token, index, maxRetries);

    // Small delay between starting each bot to avoid rate limits
    await sleep(500);
  }
}

/**
 * Initialize a single bot with retry logic
 */
async function initBotWithRetry(token, index, retriesLeft) {
  try {
    const bot = await initBot(token, index);
    botPool.push(bot);
    botsInitialized++;
    console.log(`[Discord] ✓ Bot ${index + 1} ready: ${bot.name} → Channel ${bot.uploadChannelId} (${botPool.length}/${totalConfiguredBots} active)`);

    if (botsInitialized + botsFailed === totalConfiguredBots) {
      onAllBotsProcessed();
    }
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[Discord] ⟳ Bot ${index + 1} failed (${err.message}), retrying... (${retriesLeft} attempts left)`);
      await sleep(5000); // Wait 5s before retry
      return initBotWithRetry(token, index, retriesLeft - 1);
    } else {
      botsFailed++;
      console.error(`[Discord] ✗ Bot ${index + 1} failed after all retries: ${err.message}`);

      if (botsInitialized + botsFailed === totalConfiguredBots) {
        onAllBotsProcessed();
      }
    }
  }
}

/**
 * Called when all bots have been processed (success or fail)
 */
function onAllBotsProcessed() {
  initializationComplete = true;
  console.log(`[Discord] ═══════════════════════════════════════`);
  console.log(`[Discord] Initialization complete: ${botPool.length}/${totalConfiguredBots} bots ready`);
  if (botsFailed > 0) {
    console.warn(`[Discord] ${botsFailed} bot(s) failed to initialize`);
  }
  console.log(`[Discord] ═══════════════════════════════════════`);
}

/**
 * Get next bot using round-robin with least-busy preference
 */
function getNextBot() {
  if (botPool.length === 0) {
    throw new Error('Discord not initialized');
  }

  if (botPool.length === 1) {
    return botPool[0];
  }

  // Find least busy bot
  let leastBusy = botPool[0];
  for (const bot of botPool) {
    if (bot.busy < leastBusy.busy) {
      leastBusy = bot;
    }
  }

  // If all equally busy, use round-robin
  if (botPool.every(b => b.busy === leastBusy.busy)) {
    const bot = botPool[currentBotIndex];
    currentBotIndex = (currentBotIndex + 1) % botPool.length;
    return bot;
  }

  return leastBusy;
}

/**
 * Get all bots (for parallel operations)
 */
function getAllBots() {
  if (botPool.length === 0) {
    throw new Error('Discord not initialized');
  }
  return botPool;
}

/**
 * Get bot count
 */
function getBotCount() {
  return botPool.length;
}

// Backward compatibility functions
function getChannel() {
  return getNextBot().channel;
}

function getClient() {
  return getNextBot().client;
}

async function sendMessage(content) {
  const bot = getNextBot();
  return bot.channel.send(content);
}

const MAX_ATTACHMENTS_PER_MESSAGE = 10;

async function sendFile(buffer, filename) {
  const results = await sendFileBatch([{ buffer, filename, partIndex: null }]);
  const result = results[0];
  return {
    messageId: result.messageId,
    url: result.url,
    size: result.size,
  };
}

/**
 * Send file batch using a specific bot
 */
async function sendFileBatchWithBot(bot, chunks, logger = null) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('sendFileBatchWithBot requires at least one chunk');
  }
  if (chunks.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`sendFileBatchWithBot supports up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
  }

  const totalBytes = chunks.reduce((sum, c) => sum + c.buffer.length, 0);
  const partIndexes = chunks.map(c => c.partIndex);
  const sendStart = Date.now();

  bot.busy++;
  try {
    return await withRetry(async () => {
      const attachStart = Date.now();
      const attachments = chunks.map(({ buffer, filename }) => new AttachmentBuilder(buffer, { name: filename }));
      const attachTime = Date.now() - attachStart;

      const apiStart = Date.now();
      // Use uploadChannel for uploads (assigned based on bot index for multi-channel support)
      const message = await bot.uploadChannel.send({ files: attachments });
      const apiTime = Date.now() - apiStart;

      // Log rate limit info from Discord REST client
      const rest = bot.client.rest;
      if (rest) {
        const rateLimitInfo = {
          globalRemaining: rest.globalRemaining,
          globalReset: rest.globalReset,
        };
        console.log(`[RateLimit] ${bot.name}: globalRemaining=${rateLimitInfo.globalRemaining}, globalReset=${rateLimitInfo.globalReset ? new Date(rateLimitInfo.globalReset).toISOString() : 'none'}`);
      }

      const totalTime = Date.now() - sendStart;

      // Log to file if logger provided
      if (logger && logger.logDiscordUpload) {
        logger.logDiscordUpload(bot.name, partIndexes, totalBytes, attachTime, apiTime, totalTime);
      } else {
        const speedMBps = totalTime > 0 ? (totalBytes / 1024 / 1024) / (totalTime / 1000) : 0;
        console.log(`[PERF] ${bot.name} sent parts=[${partIndexes.join(',')}]: ${(totalBytes / 1024 / 1024).toFixed(2)}MB in ${totalTime}ms (attach=${attachTime}ms, api=${apiTime}ms) = ${speedMBps.toFixed(2)}MB/s`);
      }

      // Discord may modify filenames (spaces, special chars), so match by index order
      const receivedAttachments = Array.from(message.attachments.values());

      if (receivedAttachments.length !== chunks.length) {
        throw new Error(`Attachment count mismatch: sent ${chunks.length}, received ${receivedAttachments.length}`);
      }

      return chunks.map((chunk, index) => {
        const attachmentData = receivedAttachments[index];
        if (!attachmentData) {
          throw new Error(`Missing attachment data at index ${index} for ${chunk.filename}`);
        }
        return {
          messageId: message.id,
          url: attachmentData.url,
          size: attachmentData.size,
          partIndex: chunk.partIndex,
        };
      });
    }, `sendFileBatch[${bot.name}](${chunks.length} attachments)`);
  } finally {
    bot.busy--;
  }
}

/**
 * Send file batch (uses next available bot)
 */
async function sendFileBatch(chunks) {
  const bot = getNextBot();
  return sendFileBatchWithBot(bot, chunks);
}

/**
 * Send multiple batches in parallel using all available bots
 * @param {Array<Array>} batches - Array of chunk arrays, each will be sent as one message
 * @param {Object} logger - Optional performance logger
 * @returns {Promise<Array>} - Flat array of all results
 */
async function sendFileBatchesParallel(batches, logger = null) {
  if (!Array.isArray(batches) || batches.length === 0) {
    return [];
  }

  const parallelStart = Date.now();
  const totalChunks = batches.reduce((sum, b) => sum + b.length, 0);
  const totalBytes = batches.reduce((sum, b) => sum + b.reduce((s, c) => s + c.buffer.length, 0), 0);

  if (logger && logger.log) {
    logger.log('Starting parallel upload', {
      batches: batches.length,
      chunks: totalChunks,
      totalMB: (totalBytes / 1024 / 1024).toFixed(2),
      bots: botPool.length,
    });
  } else {
    console.log(`[PERF] Starting parallel upload: ${batches.length} batches, ${totalChunks} chunks, ${(totalBytes / 1024 / 1024).toFixed(2)}MB, bots=${botPool.length}`);
  }

  const bots = getAllBots();
  const results = [];
  const pending = [...batches];
  const inFlight = new Map(); // bot -> promise

  return new Promise((resolve, reject) => {
    let hasError = false;

    function pickAvailableBot() {
      const available = bots.filter(bot => !inFlight.has(bot));
      if (available.length === 0) return null;
      let leastBusy = available[0];
      for (const bot of available) {
        if (bot.busy < leastBusy.busy) {
          leastBusy = bot;
        }
      }
      return leastBusy;
    }

    function startNext() {
      if (hasError) return;

      // Find available bots and assign work (prefer least busy across the pool)
      while (pending.length > 0) {
        const bot = pickAvailableBot();
        if (!bot) break;
        const batch = pending.shift();
        const promise = sendFileBatchWithBot(bot, batch, logger)
          .then(result => {
            results.push(...result);
            inFlight.delete(bot);
            startNext();
          })
          .catch(err => {
            hasError = true;
            reject(err);
          });
        inFlight.set(bot, promise);
      }

      // Check if done
      if (pending.length === 0 && inFlight.size === 0 && !hasError) {
        const totalTime = Date.now() - parallelStart;
        const speedMBps = totalTime > 0 ? (totalBytes / 1024 / 1024) / (totalTime / 1000) : 0;

        if (logger && logger.log) {
          logger.log('Parallel upload complete', {
            totalTimeMs: totalTime,
            speedMBps: speedMBps.toFixed(2),
            chunksUploaded: results.length,
          });
        } else {
          console.log(`[PERF] Parallel upload complete: ${totalTime}ms, ${speedMBps.toFixed(2)}MB/s effective`);
        }

        resolve(results);
      }
    }

    startNext();
  });
}

/**
 * Get a channel by ID from any available bot
 * Used for downloads - bots can download from any channel
 */
function getChannelById(channelId) {
  for (const bot of botPool) {
    const channel = bot.allChannels.get(channelId);
    if (channel) return channel;
  }
  // Fallback to primary channel if not found
  return getNextBot().uploadChannel;
}

/**
 * Get all available channel IDs
 */
function getAllChannelIds() {
  return allChannelIds;
}

async function deleteMessage(messageId) {
  // Try all bots since they may have access to different channels (multi-server setup)
  for (const bot of botPool) {
    for (const channel of bot.allChannels.values()) {
      try {
        const message = await channel.messages.fetch(messageId);
        await message.delete();
        return true;
      } catch (error) {
        // Message not in this channel or bot can't access, try next
        continue;
      }
    }
  }
  console.error(`Failed to delete message ${messageId}: not found in any channel`);
  return false;
}

async function deleteMessagesBulk(messageIds = []) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return;
  const chunkSize = 100;
  let remaining = [...messageIds];

  // Try each bot's channels (multi-server setup: bots have access to different channels)
  for (const bot of botPool) {
    if (remaining.length === 0) break;

    for (const channel of bot.allChannels.values()) {
      if (remaining.length === 0) break;

      // Process in chunks of 100 (Discord bulk delete limit)
      const toDelete = [...remaining];
      for (let i = 0; i < toDelete.length; i += chunkSize) {
        const chunk = toDelete.slice(i, i + chunkSize).filter(Boolean);
        if (chunk.length === 0) continue;

        if (chunk.length === 1) {
          // Single delete - deleteMessage already tries all bots
          if (await deleteMessage(chunk[0])) {
            remaining = remaining.filter(id => id !== chunk[0]);
          }
          continue;
        }

        try {
          const deleted = await channel.bulkDelete(chunk, true);
          const deletedIds = new Set(deleted.keys());
          remaining = remaining.filter(id => !deletedIds.has(id));
        } catch (error) {
          // Some messages may not be in this channel, continue to next
        }
      }
    }
  }

  if (remaining.length > 0) {
    console.warn(`[Discord] Could not delete ${remaining.length} message(s)`);
  }
}

async function destroyDiscord() {
  for (const bot of botPool) {
    try {
      await bot.client.destroy();
    } catch (e) {
      // ignore
    }
  }
  botPool = [];
  currentBotIndex = 0;
}

module.exports = {
  initDiscord,
  getChannel,
  getChannelById,
  getAllChannelIds,
  getClient,
  getNextBot,
  getAllBots,
  getBotCount,
  sendMessage,
  sendFile,
  sendFileBatch,
  sendFileBatchWithBot,
  sendFileBatchesParallel,
  deleteMessage,
  deleteMessagesBulk,
  destroyDiscord,
};
