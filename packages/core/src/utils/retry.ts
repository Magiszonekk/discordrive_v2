import { sleep } from './file.js';

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Retry wrapper with exponential backoff for Discord API calls.
 * Retries on rate limit (429) and network errors.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string = 'operation',
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      const isRateLimit =
        error.status === 429 ||
        error.code === 429 ||
        error.httpStatus === 429 ||
        (error.message && error.message.toLowerCase().includes('rate limit'));

      const isNetworkError =
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.message?.includes('getaddrinfo') ||
        error.message?.includes('socket hang up');

      if (!isRateLimit && !isNetworkError) {
        throw error;
      }

      if (attempt === config.maxRetries) {
        console.error(`[Discordrive] ${operationName} failed after ${config.maxRetries} attempts`);
        throw error;
      }

      let delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);

      if (error.retryAfter) {
        delay = Math.max(delay, error.retryAfter * 1000);
      }

      // Jitter ±20%
      delay = delay * (0.8 + Math.random() * 0.4);
      delay = Math.min(delay, config.maxDelayMs);

      console.warn(
        `[Discordrive] ${operationName} failed (attempt ${attempt}/${config.maxRetries}), ` +
          `retrying in ${Math.round(delay)}ms... Error: ${error.message}`,
      );

      await sleep(delay);
    }
  }

  throw lastError;
}
