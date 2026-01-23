"use client";

import { useEffect, useRef, useState } from "react";
import { FileItemRow } from "./FileItem";
import { RenameFileDialog } from "./RenameFileDialog";
import { DownloadProgressDialog, DownloadStatus } from "./DownloadProgressDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { FileItem, Folder } from "@/types";
import { toast } from "sonner";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import { Download, FolderInput, Trash2, Archive } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ShareDialog } from "@/components/shares/ShareDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import JSZip from "jszip";
import { getFileInfo, fetchFilePart, setFilePasswordApi, removeFilePasswordApi } from "@/lib/api";
import {
  ensureEncryptionKey,
  parseEncryptionHeader,
  deriveKey,
  decryptChunk,
  base64ToBytes,
  saveCryptoPrefs,
} from "@/lib/crypto-client";
import { setFilePassword, clearFilePassword, getFilePassword } from "@/lib/password-store";

interface FileListProps {
  folderId: number | null;
  files: FileItem[];
  folders: Folder[];
  isLoading: boolean;
  onMoveFile: (fileId: number, folderId: number | null) => Promise<void>;
  onDeleteFile: (fileId: number) => Promise<void>;
  onReorderFiles: (orderedIds: number[], folderId: number | null) => Promise<void> | void;
}

export function FileList({
  folderId,
  files,
  folders,
  isLoading,
  onMoveFile,
  onDeleteFile,
  onReorderFiles,
}: FileListProps) {
  const queryClient = useQueryClient();
  const [fileToDelete, setFileToDelete] = useState<FileItem | null>(null);
  const [fileToRename, setFileToRename] = useState<FileItem | null>(null);
  const [downloadFile, setDownloadFile] = useState<FileItem | null>(null);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [reorderPending, setReorderPending] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [downloadQueue, setDownloadQueue] = useState<FileItem[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const handleMoveFile = async (fileId: number, direction: "up" | "down") => {
    if (reorderPending) return;
    const index = files.findIndex((f) => f.id === fileId);
    if (index === -1) return;

    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= files.length) return;

    const newOrder = arrayMove(files, index, newIndex);
    setReorderPending(true);
    try {
      await onReorderFiles(newOrder.map((f) => f.id), folderId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reorder files");
    } finally {
      setReorderPending(false);
    }
  };

  const handleMoveToFolder = async (fileId: number, targetFolderId: number | null) => {
    const file = files.find((f) => f.id === fileId);
    if (!file) return;
    if ((file.folderId ?? null) === (targetFolderId ?? null)) return;

    try {
      await onMoveFile(fileId, targetFolderId);
      toast.success(targetFolderId === null ? "File moved to All Files" : "File moved to folder");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move file");
    }
  };

  const toggleSelect = (fileId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const selectAll = () => setSelectedIds(new Set(files.map((f) => f.id)));

  const selectedFiles = files.filter((f) => selectedIds.has(f.id));
  const selectedCount = selectedFiles.length;
  const allSelected = selectedCount === files.length && files.length > 0;
  const noneSelected = selectedCount === 0;

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = !noneSelected && !allSelected;
  }, [allSelected, noneSelected]);

  const handleBulkDelete = async () => {
    if (!selectedFiles.length) return;
    try {
      setDeletePending(true);
      for (const file of selectedFiles) {
        await onDeleteFile(file.id);
      }
      toast.success(`Deleted ${selectedFiles.length} file(s)`);
      clearSelection();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete files");
    } finally {
      setDeletePending(false);
      setBulkDeleteOpen(false);
    }
  };

  const handleBulkMove = async (targetFolderId: number | null) => {
    if (!selectedFiles.length) return;
    try {
      for (const file of selectedFiles) {
        if ((file.folderId ?? null) !== (targetFolderId ?? null)) {
          await onMoveFile(file.id, targetFolderId);
        }
      }
      toast.success(
        targetFolderId === null
          ? `Moved ${selectedFiles.length} file(s) to All Files`
          : `Moved ${selectedFiles.length} file(s)`
      );
      clearSelection();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move files");
    }
  };

  const startDownloadQueue = (filesToDownload: FileItem[]) => {
    if (!filesToDownload.length) return;
    setDownloadQueue(filesToDownload);
    setDownloadFile(filesToDownload[0]);
    setDownloadDialogOpen(true);
  };

  const downloadFileToBuffer = async (file: FileItem, signal?: AbortSignal): Promise<Uint8Array> => {
    const infoResponse = await getFileInfo(file.id);
    const info = infoResponse.file;
    if (!info.parts || info.parts.length === 0) {
      throw new Error(`Brak części pliku ${file.originalName}`);
    }

    const password = ensureEncryptionKey();
    const { salt, ivLength, tagLength, method, pbkdf2Iterations } = parseEncryptionHeader(
      info.encryptionHeader || file.encryptionHeader
    );
    saveCryptoPrefs(password, method || "chunked-aes-gcm-12");
    const key = await deriveKey(password, salt, pbkdf2Iterations);
    const parts = [...info.parts];
    const totalSize = info.size ?? parts.reduce((sum, p) => sum + (p.plainSize || 0), 0);
    const concurrency = Math.min(6, Math.max(2, typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4));
    let nextToStart = 0;
    let downloadError: Error | null = null;
    const readyParts = new Map<number, Uint8Array>();
    const inFlight = new Set<Promise<void>>();

    const startNext = () => {
      while (inFlight.size < concurrency && nextToStart < parts.length && !downloadError) {
        const part = parts[nextToStart++];
        const promise = (async () => {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const response = await fetchFilePart(info.id, part.partNumber, signal);
          const cipher = new Uint8Array(await response.arrayBuffer());
          const iv = base64ToBytes(part.iv || "");
          if (iv.length !== ivLength) throw new Error("Invalid IV length");
          const tagBytes = tagLength || 16;
          if (cipher.length < tagBytes) throw new Error("Corrupted ciphertext");
          const plain = await decryptChunk(cipher, key, iv);
          readyParts.set(part.partNumber, plain);
        })()
          .catch((err) => {
            downloadError = err instanceof Error ? err : new Error("Download failed");
          })
          .finally(() => {
            inFlight.delete(promise);
          });
        inFlight.add(promise);
      }
    };

    startNext();
    while (inFlight.size > 0 || nextToStart < parts.length) {
      if (downloadError) throw downloadError;
      startNext();
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    }

    if (downloadError) throw downloadError;
    const buffers: Uint8Array[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const buf = readyParts.get(i);
      if (!buf) throw new Error(`Missing part ${i}`);
      buffers.push(buf);
    }
    const size = buffers.reduce((sum, b) => sum + b.byteLength, 0);
    const result = new Uint8Array(size || totalSize || 0);
    let offset = 0;
    for (const buf of buffers) {
      result.set(buf, offset);
      offset += buf.byteLength;
    }
    return result;
  };

  const ensurePasswordForFile = (file: FileItem): boolean => {
    if (!file.locked) return true;
    if (getFilePassword(file.id)) return true;
    const pwd = window.prompt(`Plik "${file.originalName}" jest zablokowany. Podaj hasło:`);
    if (!pwd || pwd.trim().length === 0) {
      toast.error("Hasło wymagane do tej operacji");
      return false;
    }
    setFilePassword(file.id, pwd.trim());
    return true;
  };

  const handleDownloadZip = async () => {
    const filesToDownload = selectedFiles;
    if (!filesToDownload.length || bulkDownloading) return;
    // Ensure we have passwords cached for locked files
    for (const file of filesToDownload) {
      if (file.locked && !getFilePassword(file.id)) {
        const pwd = window.prompt(`Plik "${file.originalName}" jest zablokowany. Podaj hasło:`);
        if (!pwd || pwd.trim().length === 0) {
          toast.error("Przerwano – brak hasła do zablokowanego pliku");
          return;
        }
        setFilePassword(file.id, pwd.trim());
      }
    }

    setBulkDownloading(true);
    setBulkStatus("Przygotowywanie ZIP...");
    try {
      const zip = new JSZip();
      const controller = new AbortController();
      const downloads = filesToDownload.map(async (file, idx) => {
        setBulkStatus(`Pobieranie ${idx + 1}/${filesToDownload.length}: ${file.originalName}`);
        const data = await downloadFileToBuffer(file, controller.signal);
        zip.file(file.originalName, data);
      });
      await Promise.all(downloads);
      setBulkStatus("Generowanie ZIP...");
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `files-${filesToDownload.length}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success(`Pobrano ZIP (${filesToDownload.length} pliki)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ZIP download failed";
      toast.error(message);
    } finally {
      setBulkStatus(null);
      setBulkDownloading(false);
    }
  };

  const handleDownloadFinished = (status: DownloadStatus) => {
    if (downloadQueue.length <= 1) {
      setDownloadQueue([]);
      setDownloadFile(null);
      setDownloadDialogOpen(false);
      return;
    }
    if (status === "error" || status === "cancelled") {
      setDownloadQueue([]);
      setDownloadFile(null);
      setDownloadDialogOpen(false);
      return;
    }
    setDownloadQueue((prev) => {
      const [, ...rest] = prev;
      if (rest.length > 0) {
        setDownloadFile(rest[0]);
        setDownloadDialogOpen(true);
        return rest;
      }
      setDownloadFile(null);
      setDownloadDialogOpen(false);
      return [];
    });
  };

  const handleDeleteFile = async () => {
    if (!fileToDelete) return;
    if (fileToDelete.locked && !getFilePassword(fileToDelete.id)) {
      const pwd = window.prompt("Plik jest zablokowany. Podaj hasło do usunięcia:");
      if (!pwd || pwd.trim().length === 0) {
        toast.error("Hasło wymagane do usunięcia zablokowanego pliku");
        return;
      }
      setFilePassword(fileToDelete.id, pwd.trim());
    }
    try {
      setDeletePending(true);
      await onDeleteFile(fileToDelete.id);
      toast.success("File deleted");
      setFileToDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete file");
    } finally {
      setDeletePending(false);
    }
  };

  const handleLockFile = async (file: FileItem) => {
    const pwd = window.prompt("Set password for this file. Ustawiasz tylko z IP uploadu.");
    if (!pwd || pwd.trim().length === 0) return;
    try {
      await setFilePasswordApi(file.id, pwd.trim());
      setFilePassword(file.id, pwd.trim());
      toast.success("Password set");
      queryClient.invalidateQueries({ queryKey: ["files"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to set password");
    }
  };

  const handleUnlockFile = async (file: FileItem) => {
    const current = window.prompt("Enter current password to unlock this file");
    if (!current || current.trim().length === 0) return;
    try {
      await removeFilePasswordApi(file.id, current.trim());
      clearFilePassword(file.id);
      toast.success("Password removed");
      queryClient.invalidateQueries({ queryKey: ["files"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove password");
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-18 w-full" />
        ))}
      </div>
    );
  }

  if (!files.length) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>No files {folderId === null ? "in All Files" : "in this folder"} yet</p>
        <p className="text-sm">Upload a file to get started</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center justify-between gap-3 text-sm flex-wrap">
          <label className="flex items-center gap-2">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected && !noneSelected}
              onChange={() => {
                if (noneSelected || !allSelected) {
                  selectAll();
                } else {
                  clearSelection();
                }
              }}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-muted-foreground">Select</span>
          </label>

          {selectedCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{selectedCount} selected</span>
              <Button
                variant="secondary"
                size="sm"
                className="h-8 gap-1"
                onClick={() => startDownloadQueue(selectedFiles)}
                disabled={bulkDownloading}
              >
                <Download className="h-4 w-4" />
                Download (kolejka)
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-8 gap-1"
                onClick={handleDownloadZip}
                disabled={bulkDownloading}
              >
                <Archive className="h-4 w-4" />
                Download ZIP
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" className="h-8 gap-1">
                    <FolderInput className="h-4 w-4" />
                    Move to
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => handleBulkMove(null)}>All Files</DropdownMenuItem>
                  {folders
                    .filter((f) => f.id !== folderId)
                    .map((folder) => (
                      <DropdownMenuItem key={folder.id} onClick={() => handleBulkMove(folder.id)}>
                        {folder.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="destructive"
                size="sm"
                className="h-8 gap-1"
                onClick={() => setBulkDeleteOpen(true)}
                disabled={bulkDownloading}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
              {bulkStatus && (
                <span className="text-xs text-muted-foreground">
                  {bulkStatus}
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground">Select files to bulk download, move, or delete.</span>
          )}
        </div>
      </div>

      <SortableContext items={files.map((f) => `file-${f.id}`)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {files.map((file, index) => (
            <FileItemRow
              key={file.id}
              file={file}
              folders={folders}
              onDelete={() => setFileToDelete(file)}
              onRename={() => setFileToRename(file)}
              onDownload={() => {
                if (!ensurePasswordForFile(file)) return;
                setDownloadFile(file);
                setDownloadDialogOpen(true);
              }}
              onShare={() => {
                if (file.locked && !getFilePassword(file.id)) {
                  const pwd = window.prompt(`Plik "${file.originalName}" jest zablokowany. Podaj hasło aby udostępnić:`);
                  if (!pwd || pwd.trim().length === 0) {
                    toast.error("Hasło wymagane do udostępnienia zablokowanego pliku");
                    return;
                  }
                  setFilePassword(file.id, pwd.trim());
                }
                setShareFile(file);
              }}
              onMoveToFolder={(fid) => handleMoveToFolder(file.id, fid)}
              onMoveUp={() => handleMoveFile(file.id, "up")}
              onMoveDown={() => handleMoveFile(file.id, "down")}
              isFirst={index === 0}
              isLast={index === files.length - 1}
              isSelected={selectedIds.has(file.id)}
              onToggleSelect={() => toggleSelect(file.id)}
              locked={file.locked}
              onLock={() => handleLockFile(file)}
              onUnlock={() => handleUnlockFile(file)}
            />
          ))}
        </div>
      </SortableContext>

      <AlertDialog open={!!fileToDelete} onOpenChange={(open) => !open && setFileToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete File</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{fileToDelete?.originalName}&quot;? This will also remove
              the file from Discord. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteFile}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deletePending}
            >
              {deletePending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete selected files</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectedCount} file{selectedCount === 1 ? "" : "s"}? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleBulkDelete}
              disabled={deletePending}
            >
              {deletePending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {fileToRename && (
        <RenameFileDialog
          file={fileToRename}
          open={!!fileToRename}
          onOpenChange={(open) => {
            if (!open) {
              setFileToRename(null);
            }
          }}
        />
      )}

      <DownloadProgressDialog
        file={downloadFile}
        open={downloadDialogOpen}
        onOpenChange={(open) => {
          setDownloadDialogOpen(open);
          if (!open) {
            setDownloadFile(null);
          }
        }}
        onFinished={handleDownloadFinished}
      />

      {shareFile && (
        <ShareDialog
          resourceType="file"
          resourceId={shareFile.id}
          resourceName={shareFile.originalName}
          mimeType={shareFile.mimeType}
          mediaWidth={shareFile.mediaWidth}
          mediaHeight={shareFile.mediaHeight}
          open={!!shareFile}
          onOpenChange={(open) => {
            if (!open) {
              setShareFile(null);
            }
          }}
        />
      )}
    </>
  );
}
