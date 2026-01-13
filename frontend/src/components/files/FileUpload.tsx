"use client";

import { useCallback, useEffect, useState } from "react";
import { Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useUpload } from "@/hooks/useUpload";
import { cn } from "@/lib/utils";
import { getDebugPreference, subscribeDebugPreference } from "@/lib/debug-prefs";

interface FileUploadProps {
  folderId?: number | null;
}

export function FileUpload({ folderId }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [showDebug, setShowDebug] = useState(() => getDebugPreference());
  const { uploads, uploadFile, cancelUpload, removeUpload, clearCompleted } = useUpload();

  useEffect(() => {
    const unsubscribe = subscribeDebugPreference(setShowDebug);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        try {
          await uploadFile(file, folderId);
        } catch {
          // Error handled in hook
        }
      }
    },
    [uploadFile, folderId]
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        try {
          await uploadFile(file, folderId);
        } catch {
          // Error handled in hook
        }
      }
      e.target.value = "";
    },
    [uploadFile, folderId]
  );

  const activeUploads = uploads.filter(
    (u) => u.status !== "complete" && u.status !== "error" && u.status !== "cancelled"
  );
  const completedUploads = uploads.filter(
    (u) => u.status === "complete" || u.status === "error" || u.status === "cancelled"
  );

  const formatEta = (ms?: number) => {
    if (!ms) return "";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s remaining`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s remaining`;
  };

  const formatSpeed = (bps?: number) => {
    if (!bps || bps <= 0) return "";
    const mbps = bps / (1024 * 1024);
    if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
    const kbps = bps / 1024;
    return `${kbps.toFixed(0)} KB/s`;
  };

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "border-2 border-dashed rounded-lg p-4 sm:p-6 md:p-8 text-center transition-colors",
          isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 active:border-primary/50"
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Upload className="h-8 w-8 sm:h-10 sm:w-10 mx-auto mb-3 sm:mb-4 text-muted-foreground" />
        <p className="text-xs sm:text-sm text-muted-foreground mb-2">
          <span className="hidden sm:inline">Drag and drop files here, or </span>
          <span className="sm:hidden">Tap to select files or </span>
          click to select
        </p>
        <input
          type="file"
          id="file-upload"
          className="hidden"
          multiple
          onChange={handleFileSelect}
        />
        <Button variant="secondary" asChild>
          <label htmlFor="file-upload" className="cursor-pointer">
            Select Files
          </label>
        </Button>
      </div>

      {activeUploads.length > 0 && (
        <div className="space-y-2 sm:space-y-3">
          <h3 className="text-xs sm:text-sm font-medium">Uploading</h3>
          {activeUploads.map((upload) => (
            <div key={upload.id} className="p-2.5 sm:p-3 border rounded-lg space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs sm:text-sm font-medium truncate flex-1">{upload.file.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 sm:h-6 sm:w-6 shrink-0"
                  onClick={() => cancelUpload(upload.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <Progress value={upload.progress} className="h-2" />
              <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 text-xs text-muted-foreground">
                <span className="truncate">{upload.message}</span>
                <span className="shrink-0 flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2">
                  {showDebug && upload.botCount && (
                    <span className="text-[11px] sm:text-xs flex items-center gap-1">
                      <span>Bots: {upload.activeBots ?? 0}/{upload.botCount}</span>
                      {typeof upload.bufferSize === "number" && typeof upload.bufferMax === "number" && (
                        <span
                          className="text-muted-foreground"
                          title={`Encrypted chunks: queued ${upload.bufferSize}/${upload.bufferMax} (target ${upload.bufferTarget ?? upload.bufferMax}); in flight ${upload.bufferInFlight ?? 0}`}
                        >
                          • Buf: {upload.bufferSize}+{upload.bufferInFlight ?? 0}/{upload.bufferMax}
                        </span>
                      )}
                    </span>
                  )}
                  <span>
                    {upload.progress}%
                    {upload.speedBps && upload.speedBps > 0 && ` • ${formatSpeed(upload.speedBps)}`}
                    <span className="hidden sm:inline">
                      {upload.etaMs && upload.etaMs > 0 && ` • ${formatEta(upload.etaMs)}`}
                    </span>
                  </span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {completedUploads.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Completed</h3>
            <Button variant="ghost" size="sm" onClick={clearCompleted}>
              Clear
            </Button>
          </div>
          {completedUploads.map((upload) => (
            <div
              key={upload.id}
              className={cn(
                "p-3 border rounded-lg flex items-center justify-between",
                upload.status === "complete" && "border-green-500/50 bg-green-500/5",
                upload.status === "error" && "border-destructive/50 bg-destructive/5",
                upload.status === "cancelled" && "border-yellow-500/50 bg-yellow-500/5"
              )}
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium truncate block">{upload.file.name}</span>
                <span className="text-xs text-muted-foreground">
                  {upload.status === "complete" && "Upload complete"}
                  {upload.status === "error" && (upload.error || "Upload failed")}
                  {upload.status === "cancelled" && "Cancelled"}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => removeUpload(upload.id)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
