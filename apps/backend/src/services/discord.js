const { BotPool } = require('@discordrive/core');
const { Collection } = require('discord.js');
const { config } = require('../config');

/** @type {BotPool | null} */
let botPool = null;
let allChannelIds = [];

/**
 * Initialize Discord bots using @discordrive/core BotPool.
 * Starts bots in background (non-blocking) to match original behavior.
 */
async function initDiscord() {
  const tokens = config.discord.tokens;

  if (!tokens || tokens.length === 0) {
    throw new Error('No Discord tokens configured');
  }

  allChannelIds = config.discord.channelIds.length > 0
    ? config.discord.channelIds
    : [config.discord.channelId];

  botPool = new BotPool({
    tokens,
    channelIds: allChannelIds,
    botsPerChannel: config.discord.botsPerChannel,
    botInitRetries: config.discord.botInitRetries,
    proxies: config.discord.proxies,
    uploadChannelOverride: process.env.DISCORD_UPLOAD_CHANNEL_ID || undefined,
  });

  // Fire-and-forget: start bot initialization in background (non-blocking)
  // This matches the original behavior where the server doesn't wait for bots
  botPool.init().catch(err => {
    console.error('[Discord] Bot pool initialization failed:', err.message);
  });

  return { client: null, channel: null };
}

function getPool() {
  if (!botPool) throw new Error('Discord not initialized');
  return botPool;
}

// ==================== Delegated methods ====================

function getNextBot() {
  return getPool().getNextBot();
}

function getAllBots() {
  return getPool().getAllBots();
}

function getBotCount() {
  return getPool().getBotCount();
}

async function sendFileBatchWithBot(bot, chunks, logger = null) {
  return getPool().sendFileBatchWithBot(bot, chunks, logger);
}

async function sendFileBatch(chunks) {
  return getPool().sendFileBatch(chunks);
}

async function sendFileBatchesParallel(batches, logger = null) {
  return getPool().sendFileBatchesParallel(batches, logger);
}

// Local-only fetch — NO sibling fallback (used by /api/internal/message to avoid loops)
async function fetchMessageLocal(messageId, channelId) {
  return getPool().fetchMessage(messageId, channelId);
}

async function fetchMessage(messageId, channelId) {
  const message = await getPool().fetchMessage(messageId, channelId);
  if (message) return message;

  // Try sibling instances — each has bots for a different Discord channel.
  // Uses /api/internal/message which is local-only (no re-forwarding to avoid loops).
  const siblings = (process.env.SIBLING_INSTANCE_URLS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  for (const siblingUrl of siblings) {
    try {
      const resp = await fetch(`${siblingUrl}/api/internal/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.found) {
        const fakeAttachments = new Collection();
        (data.attachments || []).forEach((a, i) => fakeAttachments.set(String(i), { url: a.url, name: a.name }));
        return { attachments: fakeAttachments, author: null, _fromSibling: true };
      }
    } catch { /* sibling unavailable, skip */ }
  }

  return null;
}

async function deleteMessage(messageId) {
  return getPool().deleteMessage(messageId);
}

async function deleteMessagesBulk(messageIds = []) {
  return getPool().deleteMessagesBulk(messageIds);
}

async function pinMessage(messageId) {
  return getPool().pinMessage(messageId);
}

async function destroyDiscord() {
  if (botPool) {
    await botPool.destroy();
    botPool = null;
  }
}

// ==================== Backward-compat helpers ====================

function getChannel() {
  return getNextBot().channel;
}

function getClient() {
  return getNextBot().client;
}

function getChannelById(channelId) {
  return getPool().getChannelById(channelId);
}

function getAllChannelIds() {
  return allChannelIds;
}

async function sendMessage(content) {
  const bot = getNextBot();
  return bot.channel.send(content);
}

async function sendFile(buffer, filename) {
  const results = await sendFileBatch([{ buffer, filename, partIndex: null }]);
  const result = results[0];
  return {
    messageId: result.messageId,
    url: result.url,
    size: result.size,
  };
}

module.exports = {
  initDiscord,
  getPool,
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
  fetchMessage,
  fetchMessageLocal,
  deleteMessage,
  deleteMessagesBulk,
  pinMessage,
  destroyDiscord,
};
