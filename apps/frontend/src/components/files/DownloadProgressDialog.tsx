"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { FileItem } from "@/types";
import { fetchFilePart, getFileInfo } from "@/lib/api";
import {
  ensureEncryptionKey,
  parseEncryptionHeader,
  deriveKey,
  decryptChunk,
  base64ToBytes,
  saveCryptoPrefs,
} from "@/lib/crypto-client";
import { Download, Loader2, CheckCircle2, XCircle, X } from "lucide-react";

interface DownloadProgressDialogProps {
  file: FileItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished?: (status: DownloadStatus) => void;
}

export type DownloadStatus = "idle" | "preparing" | "downloading" | "complete" | "error" | "cancelled";

interface FileWriter {
  write: (chunk: Uint8Array) => Promise<void> | void;
  close: () => Promise<void> | void;
}

// Detect mobile browser where File System Access API often doesn't work properly
function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
    (typeof navigator !== "undefined" && "maxTouchPoints" in navigator && navigator.maxTouchPoints > 0 && /Macintosh/.test(ua));
}

async function createFileWriter(filename: string, mimeType?: string | null): Promise<FileWriter> {
  const type = mimeType || "application/octet-stream";
  if (typeof window === "undefined") {
    throw new Error("Downloads are only available in the browser");
  }

  // Skip File System Access API on mobile - it often doesn't work properly
  const isMobile = isMobileBrowser();

  // Prefer File System Access API when available for true streaming writes (desktop only)
  if (!isMobile && "showSaveFilePicker" in window) {
    try {
      const picker = window as typeof window & {
        showSaveFilePicker: (options: unknown) => Promise<{
          createWritable: () => Promise<{
            write: (chunk: BlobPart) => Promise<void> | void;
            close: () => Promise<void> | void;
          }>;
        }>;
      };
      const handle = await picker.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "File", accept: { [type]: [".*"] } }],
      });
      const writable = await handle.createWritable();
      return {
        write: (chunk) => {
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          return writable.write(copy);
        },
        close: () => writable.close(),
      };
    } catch (err) {
      // User cancelled or API failed - fall through to blob fallback
      console.log("[Download] File picker failed, using blob fallback:", err);
    }
  }

  // Fallback: accumulate in memory and trigger a blob download at the end
  console.log("[Download] Using blob fallback method", isMobile ? "(mobile detected)" : "");
  const chunks: BlobPart[] = [];
  return {
    write: (chunk) => {
      // Store a copy backed by a regular ArrayBuffer for Blob compatibility
      const copy = new Uint8Array(chunk);
      chunks.push(copy);
    },
    close: () => {
      const blob = new Blob(chunks, { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    },
  };
}

export function DownloadProgressDialog({ file, open, onOpenChange, onFinished }: DownloadProgressDialogProps) {
  const [status, setStatus] = useState<DownloadStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const onFinishedRef = useRef<((status: DownloadStatus) => void) | undefined>(undefined);
  onFinishedRef.current = onFinished;

  const handleCancel = useCallback(() => {
    controllerRef.current?.abort();
    setStatus("cancelled");
    setEta(null);
    setSpeed(null);
  }, []);

  useEffect(() => {
    if (!open || !file) {
      setStatus("idle");
      setProgress(0);
      setEta(null);
      setSpeed(null);
      setError(null);
      controllerRef.current = null;
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;

    async function run() {
      if (!file) return;
      try {
        setStatus("preparing");
        setProgress(0);
        setEta(null);
        setSpeed(null);
        setError(null);

        const infoResponse = await getFileInfo(file.id);
        const info = infoResponse.file;
        if (!info.parts || info.parts.length === 0) {
          throw new Error("File parts not found");
        }

        const password = ensureEncryptionKey();
        const { salt, ivLength, tagLength, method, pbkdf2Iterations } = parseEncryptionHeader(info.encryptionHeader || file.encryptionHeader);
        saveCryptoPrefs(password, method || "chunked-aes-gcm-12");
        const key = await deriveKey(password, salt, pbkdf2Iterations);
        const writer = await createFileWriter(info.originalName, info.mimeType);

        const startTime = performance.now();
        let bytesWritten = 0;

        // Parallel fetch/decrypt with ordered writes
        const parts = [...info.parts];
        let downloadError: Error | null = null;
        let nextToStart = 0;
        let nextToWrite = 1;
        const readyParts = new Map<number, Uint8Array>();
        const inFlight = new Set<Promise<void>>();
        const concurrency = Math.min(6, Math.max(2, typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4));
        let flushing = false;

        const flushReady = async () => {
          if (flushing) return;
          flushing = true;
          try {
            while (readyParts.has(nextToWrite)) {
              const plain = readyParts.get(nextToWrite)!;
              readyParts.delete(nextToWrite);
              await writer.write(plain);
              bytesWritten += plain.byteLength;
              nextToWrite += 1;

              const percent = Math.round((bytesWritten / info.size) * 100);
              const elapsed = performance.now() - startTime;
              const speedBps = elapsed > 0 ? Math.round((bytesWritten / elapsed) * 1000) : null;
              const remainingBytes = Math.max(info.size - bytesWritten, 0);
              const etaMs = speedBps ? Math.round((remainingBytes / speedBps) * 1000) : null;

              setProgress(percent);
              setSpeed(speedBps);
              setEta(etaMs);
            }
          } finally {
            flushing = false;
          }
        };

        const startNext = () => {
          while (inFlight.size < concurrency && nextToStart < parts.length) {
            const part = parts[nextToStart++];
            const promise = (async () => {
              if (controller.signal.aborted) {
                throw new DOMException("Aborted", "AbortError");
              }
              setStatus("downloading");

          const response = await fetchFilePart(info.id, part.partNumber, controller.signal);
              const cipher = new Uint8Array(await response.arrayBuffer());
              const iv = base64ToBytes(part.iv || "");
              if (iv.length !== ivLength) {
                throw new Error("Invalid IV length");
              }
              const tagBytes = tagLength || 16;
              if (cipher.length < tagBytes) {
                throw new Error("Corrupted ciphertext");
              }

              const plain = await decryptChunk(cipher, key, iv);
              readyParts.set(part.partNumber, plain);
              await flushReady();
            })().catch((err) => {
              downloadError = err instanceof Error ? err : new Error("Download failed");
            }).finally(() => {
              inFlight.delete(promise);
            });

            inFlight.add(promise);
          }
        };

        startNext();

        while (inFlight.size > 0 || nextToStart < parts.length || readyParts.size > 0) {
          if (controller.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          startNext();
          if (downloadError) {
            throw downloadError;
          }
          if (readyParts.has(nextToWrite)) {
            await flushReady();
          } else if (inFlight.size > 0) {
            await Promise.race(inFlight);
          } else {
            break;
          }
        }

        await writer.close();
        setStatus("complete");
        setProgress(100);
        setEta(null);
        setSpeed(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setStatus("cancelled");
          setEta(null);
          setSpeed(null);
          return;
        }
        const message = err instanceof Error ? err.message : "Download failed";
        setError(message);
        setStatus("error");
      }
    }

    run();

    return () => {
      controller.abort();
    };
  }, [open, file]);

  useEffect(() => {
    if (status === "complete" || status === "error" || status === "cancelled") {
      onFinishedRef.current?.(status);
    }
  }, [status]);

  const formatEta = (ms: number) => {
    if (ms <= 0) return "";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSecs = seconds % 60;
    return `${minutes}m ${remainingSecs}s`;
  };

  const formatSpeed = (bps: number | null) => {
    if (bps === null || Number.isNaN(bps)) return "";
    const mbps = bps / (1024 * 1024);
    return `${mbps.toFixed(2)} MB/s`;
  };

  const getStatusText = () => {
    switch (status) {
      case "idle":
      case "preparing":
        return "Preparing download...";
      case "downloading":
        return `Downloading encrypted parts... ${progress}%`;
      case "complete":
        return "Download complete!";
      case "cancelled":
        return "Download cancelled";
      case "error":
        return error || "Download failed";
      default:
        return "Processing...";
    }
  };

  const getStatusIcon = () => {
    switch (status) {
      case "complete":
        return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case "error":
        return <XCircle className="h-5 w-5 text-destructive" />;
      case "cancelled":
        return <X className="h-5 w-5 text-muted-foreground" />;
      default:
        return <Loader2 className="h-5 w-5 animate-spin" />;
    }
  };

  const isActive = status === "preparing" || status === "downloading";
  const isDone = status === "complete" || status === "error" || status === "cancelled";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Downloading File
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4 overflow-hidden">
          <p className="text-sm text-muted-foreground truncate max-w-full break-all" title={file?.originalName}>
            {file?.originalName}
          </p>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                {getStatusIcon()}
                <span>{getStatusText()}</span>
              </div>
            </div>

            <Progress value={progress} className="h-2" />

            {file && status === "downloading" && (
              <div className="text-xs text-muted-foreground flex flex-col items-center gap-1">
                <div className="flex flex-wrap items-center justify-center gap-3">
                  {speed !== null && <span>Speed: {formatSpeed(speed)}</span>}
                  {eta !== null && <span>ETA: {formatEta(eta)}</span>}
                </div>
                <span className="text-center">
                  {file.totalParts > 1 ? `${file.totalParts} parts` : "1 part"} • {file.sizeFormatted}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          {isActive && (
            <Button variant="destructive" onClick={handleCancel}>
              Cancel
            </Button>
          )}
          <Button variant={isDone ? "default" : "outline"} onClick={() => onOpenChange(false)}>
            {status === "complete" ? "Done" : "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
