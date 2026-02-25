import https from 'https';
import http from 'http';
import { sleep } from '../utils/file.js';
import type { BotPool } from '../discord/bot-pool.js';
import type { DiscordriveDatabase } from '../db/database.js';

export interface HealthcheckPartInput {
  id: number;
  file_id: number;
  discord_url: string;
  channel_id?: string | null;
}

export interface HealthcheckPartResult {
  filePartId: number;
  fileId: number;
  /** healthy = cached URL OK; url_refreshed = cached URL expired but fresh URL worked; unhealthy = truly inaccessible; error = network/timeout */
  status: 'healthy' | 'url_refreshed' | 'unhealthy' | 'error';
  httpStatus: number | null;
  responseTimeMs: number;
}

export interface HealthcheckConfig {
  concurrency: number;
  requestTimeoutMs: number;
  batchDelayMs: number;
}

export type HealthcheckProgressCallback = (
  checked: number,
  total: number,
  healthy: number,
  unhealthy: number,
  errors: number,
  refreshed: number,
) => void;

export type HealthcheckBatchCallback = (results: HealthcheckPartResult[]) => void;

const DEFAULT_CONFIG: HealthcheckConfig = {
  concurrency: 20,
  requestTimeoutMs: 10000,
  batchDelayMs: 50,
};

// Keep-alive agents for efficient HEAD requests
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 30 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 30 });

/** Simple semaphore to cap concurrent Discord API calls during lazy URL resolution */
function createSemaphore(max: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      return new Promise(resolve => {
        if (running < max) { running++; resolve(); }
        else { queue.push(() => { running++; resolve(); }); }
      });
    },
    release() {
      running--;
      if (queue.length > 0) queue.shift()!();
    },
  };
}

/**
 * Check a single part's health via HTTP HEAD request.
 */
async function checkPartHealth(
  part: HealthcheckPartInput,
  timeoutMs: number,
  signal?: AbortSignal,
  retries: number = 2,
): Promise<HealthcheckPartResult> {
  const url = part.discord_url;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      return { filePartId: part.id, fileId: part.file_id, status: 'error', httpStatus: null, responseTimeMs: 0 };
    }

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      // Combine external signal with timeout
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      const agent = url.startsWith('https') ? httpsAgent : httpAgent;
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        // @ts-ignore - agent option for node fetch
        agent,
      });

      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);

      const elapsed = Date.now() - start;

      if (response.ok) {
        return { filePartId: part.id, fileId: part.file_id, status: 'healthy', httpStatus: response.status, responseTimeMs: elapsed };
      }

      // Rate limited - wait and retry
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        await sleep(retryAfter * 1000);
        continue;
      }

      // 404, 403, 410, etc. = unhealthy (attachment gone)
      return { filePartId: part.id, fileId: part.file_id, status: 'unhealthy', httpStatus: response.status, responseTimeMs: elapsed };
    } catch (error: any) {
      if (signal?.aborted) {
        return { filePartId: part.id, fileId: part.file_id, status: 'error', httpStatus: null, responseTimeMs: 0 };
      }
      if (attempt === retries) {
        const elapsed = Date.now() - start;
        return { filePartId: part.id, fileId: part.file_id, status: 'error', httpStatus: null, responseTimeMs: elapsed };
      }
      await sleep(500 * attempt);
    }
  }

  // Unreachable, but TypeScript needs it
  return { filePartId: part.id, fileId: part.file_id, status: 'error', httpStatus: null, responseTimeMs: 0 };
}

/**
 * Extract filename from Discord CDN URL.
 * Handles both URL object parsing and fallback string parsing.
 */
function extractFilenameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/');
    return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    const withoutQuery = url.split('?')[0];
    const segments = withoutQuery.split('/');
    return decodeURIComponent(segments[segments.length - 1]);
  }
}

/**
 * Check a part's health with lazy URL resolution.
 * First tries the cached URL. If it fails with 403/404/410 (likely expired),
 * fetches the message from Discord to get a fresh URL, updates the cache,
 * and retries the health check.
 */
async function checkPartHealthWithLazyResolution(
  part: HealthcheckPartInput,
  botPool: BotPool | undefined,
  db: DiscordriveDatabase | undefined,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    retries?: number;
  },
  discordSemaphore?: ReturnType<typeof createSemaphore>,
): Promise<HealthcheckPartResult> {
  // Try 1: HEAD on cached URL
  let result = await checkPartHealth(part, options.timeoutMs, options.signal, options.retries);

  // If unhealthy due to expired URL (403/404/410) AND we have botPool
  if (
    result.status === 'unhealthy' &&
    result.httpStatus &&
    [403, 404, 410].includes(result.httpStatus) &&
    botPool &&
    db
  ) {
    try {
      // Acquire semaphore to cap concurrent Discord API calls (prevents rate-limiting)
      if (discordSemaphore) await discordSemaphore.acquire();
      let message: any;
      try {
        message = await botPool.fetchMessage((part as any).message_id, (part as any).channel_id ?? undefined);
      } finally {
        if (discordSemaphore) discordSemaphore.release();
      }

      if (message && message.attachments.size > 0) {
        // Extract fresh URL (match by filename or index)
        const attachments = Array.from(message.attachments.values());
        const filename = extractFilenameFromUrl(part.discord_url);
        let attachment = attachments.find((a: any) => a.name === filename);
        if (!attachment && attachments.length > 0) {
          attachment = attachments[0]; // Fallback to first
        }

        if (attachment && (attachment as any).url !== part.discord_url) {
          // Update cache IMMEDIATELY
          await db.updatePartUrls([{
            id: part.id,
            discordUrl: (attachment as any).url,
          }]);

          // Create updated part object
          const freshPart = { ...part, discord_url: (attachment as any).url };

          // Retry HEAD with fresh URL
          result = await checkPartHealth(freshPart, options.timeoutMs, options.signal, 1);

          // If fresh URL works, mark as url_refreshed (cached URL was stale, not truly broken)
          if (result.status === 'healthy') {
            result = { ...result, status: 'url_refreshed' };
          }
        }
      }
    } catch (err) {
      // URL resolution failed - keep original unhealthy status
      // (This is expected for deleted files)
    }
  }

  return result;
}

/**
 * Resolve pass: for parts already known to be unhealthy (stale 404),
 * skip the initial HEAD check and go straight to Discord message fetch.
 * Returns which part IDs were confirmed accessible (url_refreshed).
 */
export async function runResolvePass(
  parts: Array<HealthcheckPartInput & { message_id?: string; channel_id?: string | null }>,
  fetchMessage: (messageId: string, channelId?: string | null) => Promise<any | null>,
  db: DiscordriveDatabase,
  options: { timeoutMs: number; signal?: AbortSignal },
  onProgress?: (checked: number, total: number, refreshed: number) => void,
): Promise<{ refreshed: number; stillUnhealthy: number; refreshedPartIds: number[] }> {
  const semaphore = createSemaphore(3);
  const refreshedPartIds: number[] = [];
  let checked = 0;
  const total = parts.length;
  const queue = [...parts];
  const inFlight = new Set<Promise<void>>();

  return new Promise((resolve) => {
    if (options.signal) {
      options.signal.addEventListener('abort', () => { queue.length = 0; });
    }

    function startNext() {
      while (inFlight.size < 3 && queue.length > 0 && !options.signal?.aborted) {
        const part = queue.shift()!;
        const p: Promise<void> = (async () => {
          await semaphore.acquire();
          try {
            const messageId = (part as any).message_id;
            const channelId = (part as any).channel_id ?? undefined;
            if (!messageId) return;
            const message = await fetchMessage(messageId, channelId);
            if (message && message.attachments.size > 0) {
              const attachments = Array.from(message.attachments.values());
              const filename = extractFilenameFromUrl(part.discord_url);
              const attachment = (attachments.find((a: any) => a.name === filename) || attachments[0]) as any;
              if (attachment?.url) {
                await db.updatePartUrls([{ id: part.id, discordUrl: attachment.url }]);
                const freshPart = { ...part, discord_url: attachment.url };
                const headResult = await checkPartHealth(freshPart, options.timeoutMs, options.signal, 1);
                if (headResult.status === 'healthy') {
                  refreshedPartIds.push(part.id);
                }
              }
            }
          } catch { /* keep as unhealthy */ }
          finally {
            semaphore.release();
          }
          checked++;
          onProgress?.(checked, total, refreshedPartIds.length);
        })().then(() => { inFlight.delete(p); startNext(); });
        inFlight.add(p);
      }
      if (inFlight.size === 0) {
        resolve({
          refreshed: refreshedPartIds.length,
          stillUnhealthy: total - refreshedPartIds.length,
          refreshedPartIds,
        });
      }
    }

    if (parts.length === 0) {
      resolve({ refreshed: 0, stillUnhealthy: 0, refreshedPartIds: [] });
      return;
    }
    startNext();
  });
}

/**
 * Run healthcheck on a list of parts with concurrency control.
 * Modeled after downloadPartsToFile in part-downloader.ts.
 */
export async function runHealthcheck(
  parts: HealthcheckPartInput[],
  config: Partial<HealthcheckConfig> = {},
  onProgress?: HealthcheckProgressCallback,
  onBatchReady?: HealthcheckBatchCallback,
  signal?: AbortSignal,
  botPool?: BotPool,
  db?: DiscordriveDatabase,
): Promise<{ healthy: number; unhealthy: number; errors: number; refreshed: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const queue = [...parts];
  const inFlight = new Set<Promise<void>>();
  let cancelled = false;

  // Limit concurrent Discord API calls to 3 to avoid rate-limiting during lazy URL resolution
  const discordSemaphore = createSemaphore(3);

  let healthy = 0;
  let unhealthy = 0;
  let errors = 0;
  let refreshed = 0;
  let checked = 0;
  const total = parts.length;

  // Buffer for batch DB writes
  const resultBuffer: HealthcheckPartResult[] = [];
  const BATCH_FLUSH_SIZE = 500;

  function flushBuffer() {
    if (resultBuffer.length > 0 && onBatchReady) {
      onBatchReady([...resultBuffer]);
      resultBuffer.length = 0;
    }
  }

  return new Promise((resolve, reject) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        cancelled = true;
        queue.length = 0;
      });
    }

    function startNext() {
      if (cancelled) {
        if (inFlight.size === 0) {
          flushBuffer();
          resolve({ healthy, unhealthy, errors, refreshed });
        }
        return;
      }

      while (inFlight.size < cfg.concurrency && queue.length > 0 && !cancelled) {
        const part = queue.shift()!;

        // Use lazy resolution if botPool and db are available, otherwise fallback
        const checkPromise = botPool && db
          ? checkPartHealthWithLazyResolution(part, botPool, db, {
              timeoutMs: cfg.requestTimeoutMs,
              signal,
              retries: 2,
            }, discordSemaphore)
          : checkPartHealth(part, cfg.requestTimeoutMs, signal, 2);

        const promise = checkPromise
          .then((result) => {
            checked++;

            if (result.status === 'url_refreshed') { healthy++; refreshed++; }
            else if (result.status === 'healthy') healthy++;
            else if (result.status === 'unhealthy') unhealthy++;
            else errors++;

            resultBuffer.push(result);

            if (resultBuffer.length >= BATCH_FLUSH_SIZE) {
              flushBuffer();
            }

            if (onProgress) {
              onProgress(checked, total, healthy, unhealthy, errors, refreshed);
            }

            inFlight.delete(promise);
            startNext();
          })
          .catch(() => {
            // checkPartHealth doesn't throw, but just in case
            checked++;
            errors++;
            inFlight.delete(promise);
            startNext();
          });

        inFlight.add(promise);
      }

      if (inFlight.size === 0 && queue.length === 0) {
        flushBuffer();
        resolve({ healthy, unhealthy, errors, refreshed });
      }
    }

    startNext();
  });
}
