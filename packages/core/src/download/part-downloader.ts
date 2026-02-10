import https from 'https';
import http from 'http';
import type { FilePartRecord } from '../types.js';
import { sleep } from '../utils/file.js';

// Shared HTTP agents with keep-alive for faster repeated requests
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });

/**
 * Fetch a single part from Discord and write it directly to a file handle.
 * Data is written at the provided offset so we can reconstruct the encrypted file.
 */
async function fetchPartToFile(
  part: FilePartRecord,
  fileHandle: import('fs').promises.FileHandle,
  offset: number,
  signal?: AbortSignal,
  retries: number = 3,
): Promise<number> {
  const url = part.discord_url;
  const agent = url.startsWith('https') ? httpsAgent : httpAgent;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (signal?.aborted) {
        throw new Error('Download cancelled');
      }
      const fetchOpts: any = { signal, agent };
      const response = await fetch(url, fetchOpts);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fileHandle.write(buffer, 0, buffer.length, offset);
      return buffer.length;
    } catch (error: any) {
      if (error.name === 'AbortError' || signal?.aborted) {
        throw new Error('Download cancelled');
      }
      if (attempt === retries) {
        throw new Error(`Failed to fetch part ${part.part_number} from Discord: ${error.message}`);
      }
      await sleep(1000 * attempt);
    }
  }

  return 0;
}

export type DownloadProgressCallback = (
  completedParts: number,
  totalParts: number,
  bytesDownloaded: number,
  totalBytes: number,
) => void;

/**
 * Download parts in parallel directly to file (memory efficient).
 * Each part is written to its calculated offset position.
 */
export async function downloadPartsToFile(
  parts: FilePartRecord[],
  fileHandle: import('fs').promises.FileHandle,
  chunkSize: number,
  concurrency: number,
  onProgress?: DownloadProgressCallback,
  signal?: AbortSignal,
): Promise<number> {
  const queue = [...parts];
  const inFlight = new Set<Promise<void>>();
  const errors: Error[] = [];
  let completedParts = 0;
  let bytesDownloaded = 0;
  let cancelled = false;
  const totalBytes = parts.reduce((sum, part) => sum + (part.size || 0), 0);

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
          reject(new Error('Download cancelled'));
        }
        return;
      }

      while (inFlight.size < concurrency && queue.length > 0 && errors.length === 0 && !cancelled) {
        const part = queue.shift()!;
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
          .catch((err) => {
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
