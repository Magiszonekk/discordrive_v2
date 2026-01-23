const https = require('https');
const http = require('http');
const { ApiError } = require('../middleware/errorHandler');
const { sleep } = require('../utils/file');

// Shared HTTP agents with keep-alive for faster repeated requests
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });

/**
 * Fetch a single part from Discord and write it directly to a file handle.
 * Data is written at the provided offset so we can reconstruct the encrypted file.
 */
async function fetchPartToFile(part, fileHandle, offset, signal, retries = 3) {
  const url = part.discord_url;
  const agent = url.startsWith('https') ? httpsAgent : httpAgent;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (signal?.aborted) {
        throw new Error('Download cancelled');
      }
      const response = await fetch(url, { agent, signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Log CDN headers for rate limit analysis
      const cdnHeaders = {
        'x-ratelimit-remaining': response.headers.get('x-ratelimit-remaining'),
        'x-ratelimit-reset': response.headers.get('x-ratelimit-reset'),
        'cf-cache-status': response.headers.get('cf-cache-status'),
        'content-length': response.headers.get('content-length'),
      };
      console.log(`[CDN] Part ${part.part_number}: remaining=${cdnHeaders['x-ratelimit-remaining'] || 'N/A'}, cache=${cdnHeaders['cf-cache-status'] || 'N/A'}, size=${cdnHeaders['content-length']}`)
      const buffer = Buffer.from(await response.arrayBuffer());
      await fileHandle.write(buffer, 0, buffer.length, offset);
      return buffer.length;
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) {
        throw new Error('Download cancelled');
      }
      if (attempt === retries) {
        throw new ApiError(502, `Failed to fetch part ${part.part_number} from Discord: ${error.message}`);
      }
      await sleep(1000 * attempt);
    }
  }
}

/**
 * Download parts in parallel directly to file (memory efficient).
 * Each part is written to its calculated offset position.
 */
async function downloadPartsToFile(parts, fileHandle, chunkSize, concurrency, onProgress, signal) {
  const queue = [...parts];
  const inFlight = new Set();
  const errors = [];
  let completedParts = 0;
  let bytesDownloaded = 0;
  let cancelled = false;
  const totalBytes = parts.reduce((sum, part) => sum + (part.size || 0), 0);

  return new Promise((resolve, reject) => {
    // Listen for abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        cancelled = true;
        queue.length = 0; // Clear pending queue
      });
    }

    function startNext() {
      if (cancelled) {
        if (inFlight.size === 0) {
          reject(new Error('Download cancelled'));
        }
        return;
      }

      while (inFlight.size < concurrency && queue.length > 0 && errors.length === 0 && !cancelled) {
        const part = queue.shift();
        const offset = (part.part_number - 1) * chunkSize;

        const promise = fetchPartToFile(part, fileHandle, offset, signal)
          .then((bytesWritten) => {
            completedParts++;
            bytesDownloaded += bytesWritten || 0;
            if (onProgress) {
              onProgress(completedParts, parts.length, bytesDownloaded, totalBytes);
            }
            inFlight.delete(promise);
            startNext();
          })
          .catch(err => {
            errors.push(err);
            inFlight.delete(promise);
            startNext();
          });
        inFlight.add(promise);
      }

      if (inFlight.size === 0) {
        if (cancelled) {
          reject(new Error('Download cancelled'));
        } else if (errors.length > 0) {
          reject(errors[0]);
        } else {
          resolve(completedParts);
        }
      }
    }

    startNext();
  });
}

module.exports = {
  downloadPartsToFile,
};
