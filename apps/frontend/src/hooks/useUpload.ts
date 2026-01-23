"use client";

import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UploadState } from "@/types";
import {
  startUploadSession,
  uploadChunkBatch,
  finishUploadSession,
  cancelUpload as apiCancelUpload,
} from "@/lib/api";
import {
  ensureEncryptionKey,
  generateSalt,
  buildEncryptionHeader,
  bytesToBase64,
  DEFAULT_CHUNK_SIZE,
  getStoredMethod,
  getMethodParams,
  saveCryptoPrefs,
  CryptoWorkerPool,
} from "@/lib/crypto-client";

const FALLBACK_CHUNK_SIZE = DEFAULT_CHUNK_SIZE;
const MAX_ENCRYPTED_CHUNK = 8 * 1024 * 1024; // 8MB hard ceiling

// How many chunks to encrypt ahead of upload (pipeline buffer)
const ENCRYPT_AHEAD_COUNT = 6;
const BUFFER_HEALTH_DEFAULT_MAX = 24; // default max buffered encrypted chunks
const BUFFER_HEALTH_CAP = 64; // absolute ceiling to avoid runaway memory use
const MAX_BUFFER_HEALTH = (() => {
  const raw = process.env.NEXT_PUBLIC_MAX_BUFFER_HEALTH || process.env.MAX_BUFFER_HEALTH;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const fallback = BUFFER_HEALTH_DEFAULT_MAX;
  const value = Number.isFinite(parsed) ? parsed : fallback;
  // Always allow at least ENCRYPT_AHEAD_COUNT and at least 1
  const lowerBounded = Math.max(ENCRYPT_AHEAD_COUNT, Math.max(1, value));
  return Math.min(BUFFER_HEALTH_CAP, lowerBounded);
})();
const PERF_SAVE_DEBOUNCE_MS = 1200;

// Performance logging helper with file export
const PERF_LOG_KEY = 'discordrive_perf_logs';
const MAX_LOG_ENTRIES = 5000;

const perf = {
  enabled: true,
  timers: new Map<string, number>(),
  logs: [] as string[],
  sessionId: '',
  saveTimer: null as number | null,
  saveQueued: false,

  init() {
    // Load existing logs from localStorage
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(PERF_LOG_KEY);
        if (stored) {
          this.logs = JSON.parse(stored);
        }
        window.addEventListener('beforeunload', () => {
          perf.scheduleSave(true);
        });
      } catch {
        this.logs = [];
      }
    }
  },

  startSession(fileName: string, fileSize: number) {
    this.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.writeLog('SESSION', `=== UPLOAD SESSION START ===`, {
      sessionId: this.sessionId,
      fileName,
      fileSize,
      fileSizeMB: (fileSize / 1024 / 1024).toFixed(2),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 'unknown',
    });
  },

  endSession(summary?: Record<string, unknown>) {
    this.writeLog('SESSION', `=== UPLOAD SESSION END ===`, {
      sessionId: this.sessionId,
      ...summary,
    });
    this.sessionId = '';
    this.scheduleSave(true);
  },

  writeLog(level: string, message: string, data?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    const logEntry = data
      ? `[${timestamp}] [${level}] ${message} ${JSON.stringify(data)}`
      : `[${timestamp}] [${level}] ${message}`;

    // Console output
    if (level === 'PERF') {
      console.log(`[PERF] ${message}`, data || '');
    } else {
      console.log(`[${level}] ${message}`, data || '');
    }

    // Store in memory and localStorage
    this.logs.push(logEntry);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
    }
    this.scheduleSave();
  },

  scheduleSave(immediate = false) {
    if (typeof window === 'undefined') return;
    if (immediate) {
      if (this.saveTimer !== null) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.saveQueued = false;
      this.save();
      return;
    }
    this.saveQueued = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (this.saveQueued) {
        this.saveQueued = false;
        this.save();
      }
    }, PERF_SAVE_DEBOUNCE_MS);
  },

  save() {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(PERF_LOG_KEY, JSON.stringify(this.logs));
      } catch {
        // localStorage full, trim logs
        this.logs = this.logs.slice(-1000);
        try {
          localStorage.setItem(PERF_LOG_KEY, JSON.stringify(this.logs));
        } catch {
          // give up
        }
      }
    }
  },

  start(label: string) {
    if (!this.enabled) return;
    this.timers.set(label, performance.now());
  },

  end(label: string, details?: string) {
    if (!this.enabled) return;
    const start = this.timers.get(label);
    if (start) {
      const duration = performance.now() - start;
      this.timers.delete(label);
      this.writeLog('PERF', `${label}: ${duration.toFixed(1)}ms`, {
        sessionId: this.sessionId,
        label,
        durationMs: Math.round(duration),
        details,
      });
      return duration;
    }
    return 0;
  },

  log(message: string, data?: Record<string, unknown>) {
    if (!this.enabled) return;
    this.writeLog('PERF', message, { sessionId: this.sessionId, ...data });
  },

  // Get all logs as downloadable text
  getLogsText(): string {
    return this.logs.join('\n');
  },

  // Download logs as file
  downloadLogs() {
    if (typeof window === 'undefined') return;
    const content = this.getLogsText();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `discordrive-frontend-perf-${new Date().toISOString().split('T')[0]}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // Clear all logs
  clearLogs() {
    this.logs = [];
    if (typeof window !== 'undefined') {
      localStorage.removeItem(PERF_LOG_KEY);
      if (this.saveTimer !== null) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.saveQueued = false;
    }
  },
};

// Initialize on load
perf.init();

// Export for global access (debugging)
if (typeof window !== 'undefined') {
  (window as unknown as { perfLogger: typeof perf }).perfLogger = perf;
}

interface EncryptedChunk {
  partNumber: number;
  cipher: Uint8Array;
  iv: string;
  authTag: string;
  plainSize: number;
}

// Dimension detection for video files
function getVideoDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight });
      URL.revokeObjectURL(video.src);
    };
    video.onerror = () => {
      URL.revokeObjectURL(video.src);
      resolve(null);
    };
    video.src = URL.createObjectURL(file);
  });
}

// Dimension detection for image files
function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      resolve(null);
    };
    img.src = URL.createObjectURL(file);
  });
}

// Get media dimensions based on file type
async function getMediaDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (file.type.startsWith("video/")) {
    return getVideoDimensions(file);
  } else if (file.type.startsWith("image/")) {
    return getImageDimensions(file);
  }
  return null;
}

export function useUpload() {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const queryClient = useQueryClient();
  const workerPoolRef = useRef<CryptoWorkerPool | null>(null);

  const updateUpload = useCallback(
    (id: string, updates: Partial<UploadState> | ((current: UploadState) => Partial<UploadState>)) => {
      setUploads((prev) =>
        prev.map((u) => {
          if (u.id !== id) return u;
          const next = typeof updates === "function" ? updates(u) : updates;
          return { ...u, ...next };
        })
      );
    },
    []
  );

  const clearCompleted = useCallback(() => {
    setUploads((prev) =>
      prev.filter((u) => u.status !== "complete" && u.status !== "error" && u.status !== "cancelled")
    );
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const uploadFile = useCallback(
    async (file: File, folderId?: number | null) => {
      const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      let startedFileId: number | null = null;
      let workerPool: CryptoWorkerPool | null = null;

      const newUpload: UploadState = {
        id: uploadId,
        file,
        status: "pending",
        progress: 0,
        message: "Preparing upload...",
        controller,
      };

      setUploads((prev) => [...prev, newUpload]);

      try {
        // Get encryption credentials
        const password = ensureEncryptionKey();
        const method = getStoredMethod();
        saveCryptoPrefs(password, method);
        const salt = generateSalt();
        const headerChunkSize = Math.min(
          FALLBACK_CHUNK_SIZE,
          MAX_ENCRYPTED_CHUNK - 1024 - 16
        );
        const { ivLength, pbkdf2Iterations } = getMethodParams(method);
        const header = buildEncryptionHeader({ salt, chunkSize: headerChunkSize, method });

        const totalParts = Math.max(1, Math.ceil(file.size / headerChunkSize));

        // Initialize worker pool
        updateUpload(uploadId, {
          status: "encrypting",
          progress: 0,
          totalParts,
          message: "Initializing encryption workers...",
        });

        // Start performance session
        perf.startSession(file.name, file.size);

        perf.start('worker-init');
        workerPool = new CryptoWorkerPool();
        workerPoolRef.current = workerPool;
        await workerPool.init(password, salt, ivLength, pbkdf2Iterations);
        perf.end('worker-init', `${workerPool.size} workers`);

        // Detect media dimensions before upload (file is still unencrypted)
        perf.start('dimension-detect');
        const mediaDims = await getMediaDimensions(file);
        perf.end('dimension-detect', mediaDims ? `${mediaDims.width}x${mediaDims.height}` : 'not a media file');

        // Start upload session
        const startResponse = await startUploadSession({
          originalName: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          totalParts,
          folderId: folderId ?? null,
          encryptionHeader: header,
          mediaWidth: mediaDims?.width ?? null,
          mediaHeight: mediaDims?.height ?? null,
        });

        const fileId = startResponse.fileId;
        startedFileId = fileId;
        const serverChunk = startResponse.chunkSize || headerChunkSize;
        const chunkSize = Math.min(serverChunk, headerChunkSize);
        const batchSize = Math.max(1, startResponse.batchSize || 3);
        const botCount = Math.max(1, startResponse.botCount || 1);
        const maxParallelCap = Math.max(1, Math.min(botCount, 12));
        const aggressiveMode = !!startResponse.aggressiveMode; // Performance testing mode
        // In aggressive mode: start at max immediately, otherwise ramp up from 3
        let maxParallelUploads = aggressiveMode ? maxParallelCap : 3;
        const bufferScaleThreshold = Math.max(1, batchSize); // lower threshold for faster scaling
        const getEncryptAheadTarget = () =>
          Math.min(totalParts, Math.max(ENCRYPT_AHEAD_COUNT, batchSize * maxParallelUploads));

        // Pipeline buffers and thresholds
        const encryptedBuffer: EncryptedChunk[] = [];
        let bufferTarget = Math.min(MAX_BUFFER_HEALTH, Math.max(ENCRYPT_AHEAD_COUNT, 1));
        let nextPartToEncrypt = 1;
        let encryptionDone = false;
        const inFlightUploads = new Set<Promise<void>>();
        const getBatchThreshold = () => Math.max(1, Math.min(batchSize, bufferTarget, MAX_BUFFER_HEALTH));
        let inFlightPartCount = 0;

        perf.log('Upload config', {
          totalParts,
          chunkSize: headerChunkSize,
          workerCount: workerPool.size,
          botCount,
          bufferScaleThreshold,
          maxParallelUploads,
          batchSize,
          pbkdf2Iterations,
          bufferMax: MAX_BUFFER_HEALTH,
          aggressiveMode,
        });

        if (aggressiveMode) {
          console.warn('[AGGRESSIVE MODE] Max parallelism enabled immediately:', maxParallelCap);
        }

        updateUpload(uploadId, {
          fileId,
          status: "uploading",
          totalParts,
          botCount,
          activeBots: 0,
          maxParallelUploads,
          bufferSize: encryptedBuffer.length,
          bufferMax: MAX_BUFFER_HEALTH,
          bufferTarget,
          bufferInFlight: inFlightPartCount,
        });

        const uploadStart = performance.now();
        let uploadedParts = 0;
        let uploadedBytes = 0;

        // Pipeline: encrypt ahead and upload in batches (parallel HTTP requests to feed multiple bots)

        // Function to encrypt the next chunk
        async function encryptNextChunk(): Promise<EncryptedChunk | null> {
          if (nextPartToEncrypt > totalParts) {
            return null;
          }

          const partNumber = nextPartToEncrypt++;
          const start = (partNumber - 1) * chunkSize;
          const end = Math.min(file.size, start + chunkSize);

          perf.start(`read-${partNumber}`);
          const plainBuffer = new Uint8Array(await file.slice(start, end).arrayBuffer());
          perf.end(`read-${partNumber}`, `${(plainBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`);

          perf.start(`encrypt-${partNumber}`);
          const result = await workerPool!.encrypt(plainBuffer);
          perf.end(`encrypt-${partNumber}`, `${(result.cipher.byteLength / 1024 / 1024).toFixed(2)}MB`);

          return {
            partNumber,
            cipher: result.cipher,
            iv: bytesToBase64(result.iv),
            authTag: bytesToBase64(result.tag),
            plainSize: result.plainSize,
          };
        }

        // Start encrypting chunks ahead
        async function fillEncryptionBuffer(): Promise<void> {
          if (encryptionDone) return;
          const encryptPromises: Promise<EncryptedChunk | null>[] = [];

          // Keep the buffer well-stocked up to MAX_BUFFER_HEALTH; do not shrink target by in-flight uploads,
          // so the queued buffer can stay full even when many parts are uploading.
          const desiredBufferSize = Math.max(
            1,
            Math.min(
              MAX_BUFFER_HEALTH,
              Math.max(
                getEncryptAheadTarget(),
                bufferScaleThreshold * 2,
                ENCRYPT_AHEAD_COUNT
              )
            )
          );
          bufferTarget = desiredBufferSize;

          while (
            encryptedBuffer.length + encryptPromises.length < desiredBufferSize &&
            nextPartToEncrypt <= totalParts
          ) {
            encryptPromises.push(encryptNextChunk());
          }

          if (encryptPromises.length > 0) {
            const results = await Promise.all(encryptPromises);
            for (const result of results) {
              if (result) {
                encryptedBuffer.push(result);
              }
            }
          }

          if (nextPartToEncrypt > totalParts) {
            encryptionDone = true;
          }
        }

        // Upload a batch of encrypted chunks
        async function uploadBatch(batch: EncryptedChunk[]): Promise<void> {
          if (batch.length === 0) return;
          if (controller.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          const metadata = batch.map((c) => ({
            partNumber: c.partNumber,
            iv: c.iv,
            authTag: c.authTag,
            plainSize: c.plainSize,
          }));
          const buffers = batch.map((c) => c.cipher);
          const batchBytes = batch.reduce((sum, c) => sum + c.cipher.byteLength, 0);
          const batchParts = batch.map(c => c.partNumber).join(',');

          perf.start(`upload-batch-${batchParts}`);
          await uploadChunkBatch(fileId, metadata, buffers, controller.signal);
          const uploadTime = perf.end(`upload-batch-${batchParts}`, `${batch.length} chunks, ${(batchBytes / 1024 / 1024).toFixed(2)}MB`) || 0;

          const uploadSpeedMBps = uploadTime > 0 ? (batchBytes / 1024 / 1024) / (uploadTime / 1000) : 0;
          perf.log(`Upload speed: ${uploadSpeedMBps.toFixed(2)} MB/s`);

          uploadedParts += batch.length;
          uploadedBytes += batchBytes;

          // Calculate progress based ONLY on uploaded parts
          const progress = Math.round((uploadedParts / totalParts) * 100);
          const elapsed = performance.now() - uploadStart;
          const speedBps = elapsed > 0 ? Math.round((uploadedBytes / elapsed) * 1000) : undefined;
          const activeBots = inFlightUploads.size;

          perf.log('Progress update', {
            uploadedParts,
            totalParts,
            progress,
            overallSpeedMBps: speedBps ? (speedBps / 1024 / 1024).toFixed(2) : 'N/A',
            bufferSize: encryptedBuffer.length,
            bufferTarget,
            bufferMax: MAX_BUFFER_HEALTH,
            bufferInFlight: inFlightPartCount,
          });

          updateUpload(uploadId, {
            status: "uploading",
            progress,
            currentPart: uploadedParts,
            totalParts,
            speedBps,
            botCount,
            activeBots,
            maxParallelUploads,
            bufferSize: encryptedBuffer.length,
            bufferMax: MAX_BUFFER_HEALTH,
            bufferTarget,
            bufferInFlight: inFlightPartCount,
            message: `Uploading ${uploadedParts}/${totalParts} parts...`,
          });

          // Release memory held by sent buffers
          for (let i = 0; i < batch.length; i++) {
            batch[i].cipher = new Uint8Array(0);
            buffers[i] = new Uint8Array(0);
          }
        }

        const dispatchUploads = () => {
          const batchThreshold = getBatchThreshold();
          while (
            inFlightUploads.size < maxParallelUploads &&
            encryptedBuffer.length > 0 &&
            (encryptedBuffer.length >= batchThreshold || encryptionDone)
          ) {
            const batch = encryptedBuffer.splice(0, Math.min(batchSize, encryptedBuffer.length));
            const partsInBatch = batch.length;
            inFlightPartCount += partsInBatch;
            const uploadPromise = uploadBatch(batch).finally(() => {
              inFlightUploads.delete(uploadPromise);
              inFlightPartCount = Math.max(0, inFlightPartCount - partsInBatch);
            });
            inFlightUploads.add(uploadPromise);
          }
        };

        const waitForNextCompletion = async () => {
          if (inFlightUploads.size === 0) return;
          await Promise.race(inFlightUploads);
        };

        const adjustParallelism = () => {
          // In aggressive mode: stay at max, never scale down
          if (aggressiveMode) return;

          const before = maxParallelUploads;
          if (encryptedBuffer.length > bufferScaleThreshold && maxParallelUploads < maxParallelCap) {
            maxParallelUploads = Math.min(maxParallelCap, maxParallelUploads + 1);
          } else if (encryptedBuffer.length < bufferScaleThreshold && maxParallelUploads > 1) {
            maxParallelUploads = Math.max(1, maxParallelUploads - 1);
          }
          if (maxParallelUploads !== before) {
            perf.log('Buffer-based parallel adjust', {
              maxParallelUploads,
              bufferSize: encryptedBuffer.length,
              bufferScaleThreshold,
              maxParallelCap,
            });
          }
        };

        // Main upload loop: pipeline encryption and upload with parallel HTTP requests
        while (!encryptionDone || encryptedBuffer.length > 0 || inFlightUploads.size > 0) {
          if (controller.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }

          await fillEncryptionBuffer();
          adjustParallelism();
          dispatchUploads();

        const shouldWaitForUploads =
          inFlightUploads.size > 0 &&
          (
            inFlightUploads.size >= maxParallelUploads ||
            (encryptionDone && encryptedBuffer.length === 0)
          );

          if (shouldWaitForUploads) {
            await waitForNextCompletion();
          } else if (!encryptionDone && encryptedBuffer.length < getBatchThreshold()) {
            // Keep encryption ahead stocked
            await fillEncryptionBuffer();
          } else if (inFlightUploads.size > 0 && encryptionDone && encryptedBuffer.length === 0) {
            await waitForNextCompletion();
          } else if (encryptedBuffer.length === 0 && inFlightUploads.size === 0 && encryptionDone) {
            break;
          }
        }

        await Promise.all(inFlightUploads);

        // Finalize
        await finishUploadSession(fileId);

        const totalTime = performance.now() - uploadStart;
        const avgSpeedMBps = (uploadedBytes / 1024 / 1024) / (totalTime / 1000);
        perf.endSession({
          status: 'complete',
          totalTimeMs: Math.round(totalTime),
          avgSpeedMBps: avgSpeedMBps.toFixed(2),
          totalParts,
          uploadedBytes,
        });

        updateUpload(uploadId, {
          status: "complete",
          progress: 100,
          message: "Upload complete!",
          fileId,
        });

        queryClient.invalidateQueries({ queryKey: ["files"] });
        queryClient.invalidateQueries({ queryKey: ["folders"] });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          perf.endSession({ status: 'cancelled' });
          updateUpload(uploadId, { status: "cancelled", message: "Upload cancelled" });
        } else {
          const message = error instanceof Error ? error.message : "Upload failed";
          perf.endSession({ status: 'error', error: message });
          updateUpload(uploadId, { status: "error", message, error: message });
          if (startedFileId) {
            try {
              await apiCancelUpload(startedFileId);
            } catch {
              // ignore cleanup errors
            }
          }
        }
      } finally {
        // Cleanup worker pool
        if (workerPool) {
          workerPool.terminate();
        }
        if (workerPoolRef.current === workerPool) {
          workerPoolRef.current = null;
        }
      }
    },
    [queryClient, updateUpload]
  );

  const cancelUpload = useCallback(
    async (uploadId: string) => {
      const upload = uploads.find((u) => u.id === uploadId);
      if (!upload) return;

      if (upload.controller) {
        upload.controller.abort();
      }

      if (upload.fileId) {
        try {
          await apiCancelUpload(upload.fileId);
        } catch {
          // ignore
        }
      }

      updateUpload(uploadId, {
        status: "cancelled",
        message: "Upload cancelled",
      });
    },
    [uploads, updateUpload]
  );

  return { uploads, uploadFile, cancelUpload, clearCompleted, removeUpload };
}
