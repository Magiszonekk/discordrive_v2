import type { BotPoolConfig, Bot, ChunkInput, UploadedChunk } from '../types.js';
import { Client, GatewayIntentBits, AttachmentBuilder } from 'discord.js';
import { withRetry } from '../utils/retry.js';
import { sleep } from '../utils/file.js';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

export class BotPool {
  private bots: Bot[] = [];
  private currentIndex = 0;
  private allChannelIds: string[] = [];
  private totalConfiguredBots = 0;
  private botsInitialized = 0;
  private botsFailed = 0;
  private initializationComplete = false;
  private config: BotPoolConfig;

  static readonly MAX_ATTACHMENTS_PER_MESSAGE = 10;

  constructor(config: BotPoolConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the upload channel ID for a bot based on its index.
   * Bots are distributed across channels: first N bots -> channel 1, next N -> channel 2, etc.
   */
  private getUploadChannelIdForBot(botIndex: number): string {
    // In multi-instance mode, all bots upload to the same override channel
    if (this.config.uploadChannelOverride) {
      return this.config.uploadChannelOverride;
    }

    const channelIds = this.config.channelIds;
    const botsPerChannel = this.config.botsPerChannel;

    if (channelIds.length === 0) {
      // Fallback to first channel (should not happen with validated config)
      return channelIds[0];
    }

    // Calculate which channel this bot should use for uploads
    const channelIndex = Math.floor(botIndex / botsPerChannel);
    // Clamp to available channels (extra bots go to last channel)
    const effectiveChannelIndex = Math.min(channelIndex, channelIds.length - 1);

    return channelIds[effectiveChannelIndex];
  }

  /**
   * Initialize a single Discord bot.
   * Each bot gets an upload channel assigned, but fetches ALL channels for downloads.
   */
  private async initBot(token: string, index: number): Promise<Bot> {
    const clientOptions: any = {
      intents: [GatewayIntentBits.Guilds],
    };

    // Determine proxy for this bot (round-robin distribution)
    let proxyUrl: string | undefined;
    if (this.config.proxies && this.config.proxies.length > 0) {
      // Create proxy pool: [direct, ...proxies]
      const proxyPool = ['direct', ...this.config.proxies];

      // Round-robin distribution
      const proxyIndex = index % proxyPool.length;
      const selectedProxy = proxyPool[proxyIndex];

      if (selectedProxy !== 'direct') {
        try {
          // Parse proxy URL to determine type
          const url = new URL(selectedProxy);

          // If the proxy points to localhost, skip setting a REST agent.
          // The process likely runs under proxychains which already routes all
          // traffic through this same address. Setting SocksProxyAgent on top
          // would cause proxychains to intercept the agent's connect() call and
          // route it through itself → self-referential loop → connection failure.
          const isLocalhost =
            url.hostname === '127.0.0.1' ||
            url.hostname === 'localhost' ||
            url.hostname === '::1';

          if (isLocalhost) {
            proxyUrl = selectedProxy;
            console.warn(
              `[BotPool] Bot ${index + 1}: Proxy ${selectedProxy} points to localhost — skipping REST agent (proxychains handles routing)`,
            );
          } else {
            let agent: any;

            if (url.protocol.startsWith('socks')) {
              agent = new SocksProxyAgent(selectedProxy);
            } else if (url.protocol === 'http:') {
              agent = new HttpProxyAgent(selectedProxy);
            } else if (url.protocol === 'https:') {
              agent = new HttpsProxyAgent(selectedProxy);
            } else {
              throw new Error(`Unsupported proxy protocol: ${url.protocol}`);
            }

            clientOptions.rest = { agent };
            proxyUrl = selectedProxy;
            console.log(`[BotPool] Bot ${index + 1}: Using proxy ${selectedProxy}`);
          }
        } catch (err: any) {
          console.warn(`[BotPool] Bot ${index + 1}: Failed to configure proxy ${selectedProxy}: ${err.message}`);
          console.warn(`[BotPool] Bot ${index + 1}: Falling back to direct connection`);
        }
      } else {
        console.log(`[BotPool] Bot ${index + 1}: Using direct connection (no proxy)`);
      }
    }

    const client = new Client(clientOptions);

    try {
      await client.login(token);
    } catch (err: any) {
      throw new Error(`Login failed for bot ${index + 1}: ${err.message || err}`);
    }

    // Wait for client to be ready
    await new Promise<void>((resolve, reject) => {
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
    const uploadChannelId = this.getUploadChannelIdForBot(index);

    // Fetch all channels (for downloads) and the upload channel
    const channelIds = this.config.channelIds;

    const allChannels = new Map<string, any>();
    let uploadChannel: any = null;

    for (const channelId of channelIds) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel) {
          allChannels.set(channelId, channel);
          if (channelId === uploadChannelId) {
            uploadChannel = channel;
          }
        }
      } catch (err: any) {
        console.warn(`[Discordrive] Bot ${index + 1} failed to fetch channel ${channelId}: ${err.message}`);
      }
    }

    if (!uploadChannel) {
      throw new Error(`Upload channel ${uploadChannelId} not found for bot ${index + 1}`);
    }

    return {
      client,
      uploadChannel,       // Channel for uploads (assigned based on bot index)
      allChannels,         // All channels (for downloads)
      channel: uploadChannel, // Backward compatibility
      busy: 0,
      name: `Bot-${index + 1} (${client.user!.tag})`,
      botIndex: index,
      uploadChannelId,
      proxyUrl,
    };
  }

  /**
   * Initialize a single bot with retry logic.
   */
  private async initBotWithRetry(token: string, index: number, retriesLeft: number): Promise<void> {
    try {
      const bot = await this.initBot(token, index);
      this.bots.push(bot);
      this.botsInitialized++;
      const proxyInfo = bot.proxyUrl ? ` via proxy ${bot.proxyUrl}` : ' (direct)';
      console.log(
        `[Discordrive] ✅ Bot ${index + 1} ready: ${bot.name} -> Channel ${bot.uploadChannelId}${proxyInfo} (${this.bots.length}/${this.totalConfiguredBots} active)`,
      );
    } catch (err: any) {
      if (retriesLeft > 0) {
        console.warn(
          `[Discordrive] Bot ${index + 1} failed (${err.message}), retrying... (${retriesLeft} attempts left)`,
        );
        await sleep(10000);
        return this.initBotWithRetry(token, index, retriesLeft - 1);
      } else {
        this.botsFailed++;
        console.error(`[Discordrive] Bot ${index + 1} failed after all retries: ${err.message}`);
      }
    }
  }

  /**
   * Load bots in background with retry support.
   * Returns promises for each bot so callers can await completion.
   */
  private async loadBotsInBackground(tokens: string[]): Promise<void> {
    const maxRetries = this.config.botInitRetries;
    const promises: Promise<void>[] = [];

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];

      // Start bot initialization with retry logic
      promises.push(this.initBotWithRetry(token, index, maxRetries));

      // Delay between starting each bot - Discord Gateway allows ~1 IDENTIFY per 5s
      await sleep(5500);
    }

    // Wait for ALL bots to finish initializing (success or fail)
    await Promise.all(promises);
  }

  /**
   * Called when all bots have been processed (success or fail).
   */
  private onAllBotsProcessed(): void {
    this.initializationComplete = true;
    console.log(`[Discordrive] ===================================`);
    console.log(`[Discordrive] Initialization complete: ${this.bots.length}/${this.totalConfiguredBots} bots ready`);
    if (this.botsFailed > 0) {
      console.warn(`[Discordrive] ${this.botsFailed} bot(s) failed to initialize`);
    }
    console.log(`[Discordrive] ===================================`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Initialize all Discord bots from config.
   * Returns a Promise that resolves once ALL bots are initialized (or failed).
   */
  async init(): Promise<void> {
    const tokens = this.config.tokens;

    if (!tokens || tokens.length === 0) {
      throw new Error('No Discord tokens configured');
    }

    // Store all channel IDs for reference
    this.allChannelIds = this.config.channelIds;

    this.totalConfiguredBots = tokens.length;
    const channelCount = this.allChannelIds.length;
    const botsPerChannel = this.config.botsPerChannel;

    console.log(`[Discordrive] Starting initialization of ${tokens.length} bot(s)...`);
    if (this.config.uploadChannelOverride) {
      console.log(`[Discordrive] Multi-instance mode: all ${tokens.length} bots → upload channel ${this.config.uploadChannelOverride} (read access to ${channelCount} channel(s))`);
    } else {
      console.log(`[Discordrive] Multi-channel mode: ${channelCount} channel(s), ${botsPerChannel} bots per channel`);
      for (let i = 0; i < this.allChannelIds.length; i++) {
        const startBot = i * botsPerChannel + 1;
        const endBot = Math.min((i + 1) * botsPerChannel, tokens.length);
        if (startBot <= endBot) {
          console.log(`[Discordrive]   Channel ${i + 1} (${this.allChannelIds[i]}): Bots ${startBot}-${endBot}`);
        }
      }
    }

    // Load all bots and wait for completion
    await this.loadBotsInBackground(tokens);

    // All bots processed
    this.onAllBotsProcessed();

    if (this.bots.length === 0) {
      throw new Error('All Discord bots failed to initialize');
    }
  }

  /**
   * Get next bot using round-robin with least-busy preference.
   */
  getNextBot(): Bot {
    if (this.bots.length === 0) {
      throw new Error('Discord not initialized');
    }

    if (this.bots.length === 1) {
      return this.bots[0];
    }

    // Find least busy bot
    let leastBusy = this.bots[0];
    for (const bot of this.bots) {
      if (bot.busy < leastBusy.busy) {
        leastBusy = bot;
      }
    }

    // If all equally busy, use round-robin
    if (this.bots.every(b => b.busy === leastBusy.busy)) {
      const bot = this.bots[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.bots.length;
      return bot;
    }

    return leastBusy;
  }

  /**
   * Get all bots (for parallel operations).
   */
  getAllBots(): Bot[] {
    if (this.bots.length === 0) {
      throw new Error('Discord not initialized');
    }
    return this.bots;
  }

  /**
   * Get bot count.
   */
  getBotCount(): number {
    return this.bots.length;
  }

  /**
   * Send file batch using a specific bot.
   */
  async sendFileBatchWithBot(
    bot: Bot,
    chunks: ChunkInput[],
    logger: any = null,
  ): Promise<UploadedChunk[]> {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw new Error('sendFileBatchWithBot requires at least one chunk');
    }
    if (chunks.length > BotPool.MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(
        `sendFileBatchWithBot supports up to ${BotPool.MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
      );
    }

    const totalBytes = chunks.reduce((sum, c) => sum + c.buffer.length, 0);
    const partIndexes = chunks.map(c => c.partIndex);
    const sendStart = Date.now();

    bot.busy++;
    try {
      return await withRetry(async () => {
        const attachStart = Date.now();
        const attachments = chunks.map(
          ({ buffer, filename }) => new AttachmentBuilder(buffer, { name: filename }),
        );
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
          console.log(
            `[RateLimit] ${bot.name}: globalRemaining=${rateLimitInfo.globalRemaining}, globalReset=${rateLimitInfo.globalReset ? new Date(rateLimitInfo.globalReset).toISOString() : 'none'}`,
          );
        }

        const totalTime = Date.now() - sendStart;

        // Log to file if logger provided
        if (logger && logger.logDiscordUpload) {
          logger.logDiscordUpload(bot.name, partIndexes, totalBytes, attachTime, apiTime, totalTime);
        } else {
          const speedMBps = totalTime > 0 ? (totalBytes / 1024 / 1024) / (totalTime / 1000) : 0;
          console.log(
            `[PERF] ${bot.name} sent parts=[${partIndexes.join(',')}]: ${(totalBytes / 1024 / 1024).toFixed(2)}MB in ${totalTime}ms (attach=${attachTime}ms, api=${apiTime}ms) = ${speedMBps.toFixed(2)}MB/s`,
          );
        }

        // Discord may modify filenames (spaces, special chars), so match by index order
        const receivedAttachments = Array.from(message.attachments.values()) as Array<{ url: string; size: number }>;

        if (receivedAttachments.length !== chunks.length) {
          throw new Error(
            `Attachment count mismatch: sent ${chunks.length}, received ${receivedAttachments.length}`,
          );
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
            channelId: bot.uploadChannelId,
          };
        });
      }, `sendFileBatch[${bot.name}](${chunks.length} attachments)`);
    } finally {
      bot.busy--;
    }
  }

  /**
   * Send file batch (uses next available bot).
   */
  async sendFileBatch(chunks: ChunkInput[]): Promise<UploadedChunk[]> {
    const bot = this.getNextBot();
    return this.sendFileBatchWithBot(bot, chunks);
  }

  /**
   * Send multiple batches in parallel using all available bots.
   * @param batches - Array of chunk arrays, each will be sent as one message
   * @param logger - Optional performance logger
   * @returns Flat array of all results
   */
  async sendFileBatchesParallel(
    batches: ChunkInput[][],
    logger: any = null,
  ): Promise<UploadedChunk[]> {
    if (!Array.isArray(batches) || batches.length === 0) {
      return [];
    }

    const parallelStart = Date.now();
    const totalChunks = batches.reduce((sum, b) => sum + b.length, 0);
    const totalBytes = batches.reduce(
      (sum, b) => sum + b.reduce((s, c) => s + c.buffer.length, 0),
      0,
    );

    if (logger && logger.log) {
      logger.log('Starting parallel upload', {
        batches: batches.length,
        chunks: totalChunks,
        totalMB: (totalBytes / 1024 / 1024).toFixed(2),
        bots: this.bots.length,
      });
    } else {
      console.log(
        `[PERF] Starting parallel upload: ${batches.length} batches, ${totalChunks} chunks, ${(totalBytes / 1024 / 1024).toFixed(2)}MB, bots=${this.bots.length}`,
      );
    }

    const bots = this.getAllBots();
    const results: UploadedChunk[] = [];
    const pending = [...batches];
    const inFlight = new Map<Bot, Promise<void>>(); // bot -> promise

    return new Promise((resolve, reject) => {
      let hasError = false;

      const pickAvailableBot = (): Bot | null => {
        const available = bots.filter(bot => !inFlight.has(bot));
        if (available.length === 0) return null;
        let leastBusy = available[0];
        for (const bot of available) {
          if (bot.busy < leastBusy.busy) {
            leastBusy = bot;
          }
        }
        return leastBusy;
      };

      const startNext = (): void => {
        if (hasError) return;

        // Find available bots and assign work (prefer least busy across the pool)
        while (pending.length > 0) {
          const bot = pickAvailableBot();
          if (!bot) break;
          const batch = pending.shift()!;
          const promise = this.sendFileBatchWithBot(bot, batch, logger)
            .then(result => {
              results.push(...result);
              inFlight.delete(bot);
              startNext();
            })
            .catch(err => {
              hasError = true;
              reject(err);
            });
          inFlight.set(bot, promise as Promise<void>);
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
            console.log(
              `[PERF] Parallel upload complete: ${totalTime}ms, ${speedMBps.toFixed(2)}MB/s effective`,
            );
          }

          resolve(results);
        }
      };

      startNext();
    });
  }

  /**
   * Get a channel by ID from any available bot.
   * Used for downloads - bots can download from any channel.
   */
  getChannelById(channelId: string): any {
    for (const bot of this.bots) {
      const channel = bot.allChannels.get(channelId);
      if (channel) return channel;
    }
    // Fallback to primary channel if not found
    return this.getNextBot().uploadChannel;
  }

  /**
   * Fetch a message by ID, trying all bots/channels.
   * Returns the Discord.js Message object or null if not found.
   * @param messageId - Discord message ID
   * @param channelId - (Optional) Known channel ID for direct lookup (stored in DB)
   */
  async fetchMessage(messageId: string, channelId?: string): Promise<any | null> {
    let foundMessage: any = null;
    let foundChannelId: string | null = null;

    // FAST PATH: If channel_id is known (stored in DB), target that channel directly
    // This eliminates "Unknown Message" spam and improves performance
    if (channelId) {
      for (const bot of this.bots) {
        const channel = bot.allChannels.get(channelId);
        if (!channel) continue;
        try {
          const message = await channel.messages.fetch(messageId, { force: true });
          if (message.attachments.size > 0) {
            return message;
          }
          if (!foundMessage) {
            foundMessage = message;
            foundChannelId = channelId;
          }
        } catch (err: any) {
          console.warn(
            `[BotPool] fetchMessage(${messageId}) failed on ${bot.name} channel ${channelId}: ${err?.message ?? err}`,
          );
          // Continue to next bot with same channel — network/rate-limit retry
        }
      }
      // If fast path found message with attachments, return early
      if (foundMessage?.attachments.size > 0) return foundMessage;
      // Else fall through to slow path (backward compat for records with null channel_id)
    }

    // SLOW PATH: Try all channels (backward compat for old records with no channel_id)
    // Try each unique channel only once per *successful* response.
    // If a bot throws (network error, rate limit), another bot with a different
    // proxy should still be allowed to retry the same channel.
    const succeededChannels = new Set<string>();
    for (const bot of this.bots) {
      for (const [chanId, channel] of bot.allChannels.entries()) {
        if (succeededChannels.has(chanId)) continue;
        try {
          const message = await channel.messages.fetch(messageId, { force: true });
          succeededChannels.add(chanId); // mark only on success
          if (message.attachments.size > 0) {
            return message;
          }
          if (!foundMessage) {
            foundMessage = message;
            foundChannelId = chanId;
          }
        } catch (err: any) {
          console.warn(
            `[BotPool] fetchMessage(${messageId}) failed on ${bot.name} channel ${chanId}: ${err?.message ?? err}`,
          );
          continue; // network/rate-limit error — let next bot retry this channel
        }
      }
    }

    if (!foundMessage) return null;

    // Message found but 0 attachments — likely a cache or MESSAGE_CONTENT issue.
    // Strategy:
    // 1. Try the bot that authored the message first (it can always see its own attachments)
    // 2. If author bot doesn't have the channel in allChannels, fall back to any bot that does
    if (foundChannelId) {
      const authorId = foundMessage.author?.id;

      // Author bot first, then all others — preserves original intent while adding fallback
      const botsToTry = authorId
        ? [
            ...this.bots.filter(b => b.client.user?.id === authorId),
            ...this.bots.filter(b => b.client.user?.id !== authorId),
          ]
        : this.bots;

      for (const bot of botsToTry) {
        const channel = bot.allChannels.get(foundChannelId);
        if (!channel) continue;
        try {
          const msg = await channel.messages.fetch(messageId, { force: true });
          if (msg.attachments.size > 0) return msg;
        } catch { /* ignore */ }
      }
    }

    return foundMessage;
  }

  /**
   * Delete a single message by trying all bots/channels.
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    // Try all bots since they may have access to different channels (multi-server setup)
    for (const bot of this.bots) {
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

  /**
   * Delete multiple messages in bulk.
   */
  async deleteMessagesBulk(messageIds: string[] = []): Promise<void> {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const chunkSize = 100;
    let remaining = [...messageIds];

    // Try each bot's channels (multi-server setup: bots have access to different channels)
    for (const bot of this.bots) {
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
            if (await this.deleteMessage(chunk[0])) {
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
      console.warn(`[Discordrive] Could not delete ${remaining.length} message(s)`);
    }
  }

  /**
   * Pin a message by ID, trying all bots/channels.
   * Returns success status with error code if applicable.
   */
  async pinMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
    for (const bot of this.bots) {
      for (const channel of bot.allChannels.values()) {
        try {
          const message = await channel.messages.fetch(messageId);
          if (message.pinned) {
            return { success: true, error: 'already_pinned' };
          }
          await message.pin();
          return { success: true };
        } catch (error: any) {
          // Discord error codes
          if (error.code === 50013) {
            throw new Error('Bot lacks MANAGE_MESSAGES permission in this channel');
          }
          if (error.code === 30003) {
            throw new Error('Channel has reached maximum pin limit (50)');
          }
          continue; // Try next channel
        }
      }
    }
    return { success: false, error: 'message_not_found' };
  }

  /**
   * Destroy all bot clients and reset state.
   */
  async destroy(): Promise<void> {
    for (const bot of this.bots) {
      try {
        await bot.client.destroy();
      } catch (e) {
        // ignore
      }
    }
    this.bots = [];
    this.currentIndex = 0;
  }
}
