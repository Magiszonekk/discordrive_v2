import https from 'https';
import http from 'http';
import { sleep } from '../utils/file.js';

export interface HealthcheckPartInput {
  id: number;
  file_id: number;
  discord_url: string;
}

export interface HealthcheckPartResult {
  filePartId: number;
  fileId: number;
  status: 'healthy' | 'unhealthy' | 'error';
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
 * Run healthcheck on a list of parts with concurrency control.
 * Modeled after downloadPartsToFile in part-downloader.ts.
 */
export async function runHealthcheck(
  parts: HealthcheckPartInput[],
  config: Partial<HealthcheckConfig> = {},
  onProgress?: HealthcheckProgressCallback,
  onBatchReady?: HealthcheckBatchCallback,
  signal?: AbortSignal,
): Promise<{ healthy: number; unhealthy: number; errors: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const queue = [...parts];
  const inFlight = new Set<Promise<void>>();
  let cancelled = false;

  let healthy = 0;
  let unhealthy = 0;
  let errors = 0;
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
          resolve({ healthy, unhealthy, errors });
        }
        return;
      }

      while (inFlight.size < cfg.concurrency && queue.length > 0 && !cancelled) {
        const part = queue.shift()!;

        const promise = checkPartHealth(part, cfg.requestTimeoutMs, signal)
          .then((result) => {
            checked++;

            if (result.status === 'healthy') healthy++;
            else if (result.status === 'unhealthy') unhealthy++;
            else errors++;

            resultBuffer.push(result);

            if (resultBuffer.length >= BATCH_FLUSH_SIZE) {
              flushBuffer();
            }

            if (onProgress) {
              onProgress(checked, total, healthy, unhealthy, errors);
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
        resolve({ healthy, unhealthy, errors });
      }
    }

    startNext();
  });
}
