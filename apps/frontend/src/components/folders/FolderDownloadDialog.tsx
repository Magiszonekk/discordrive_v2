"use client";

import { useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Folder, FileItem } from "@/types";
import { Download } from "lucide-react";
import { getFolderDownloadUrl } from "@/lib/api";

interface FolderDownloadDialogProps {
  folder: Folder;
  files?: FileItem[];
  fileCountOverride?: number;
  totalSizeOverride?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(2)} ${units[index]}`;
}

export function FolderDownloadDialog({
  folder,
  files,
  fileCountOverride,
  totalSizeOverride,
  open,
  onOpenChange,
}: FolderDownloadDialogProps) {
  const hasStarted = useRef(false);
  const computedTotalSize = files ? files.reduce((sum, file) => sum + (file.size || 0), 0) : totalSizeOverride ?? 0;
  const computedFileCount = files ? files.length : fileCountOverride ?? 0;
  const downloadUrl = getFolderDownloadUrl(folder.id);

  useEffect(() => {
    if (!open) {
      hasStarted.current = false;
      return;
    }

    if (hasStarted.current) return;
    hasStarted.current = true;

    const triggerDownload = () => {
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `${folder.name}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    triggerDownload();
  }, [open, downloadUrl, folder.name]);

  const handleManualDownload = () => {
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `${folder.name}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Downloading Folder
          </DialogTitle>
          <DialogDescription>
            Preparing ZIP archive for <span className="font-medium text-foreground">{folder.name}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            {computedFileCount} file{computedFileCount === 1 ? "" : "s"}
            {computedTotalSize ? ` • ${formatSize(computedTotalSize)}` : ""}
          </p>
          <p>The download should start automatically. If it does not, use the button below.</p>
        </div>

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:gap-2">
          <Button variant="outline" onClick={handleManualDownload}>
            Download ZIP
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
