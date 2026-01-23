"use client";

import {
  File,
  Download,
  Trash2,
  MoreVertical,
  ChevronUp,
  ChevronDown,
  GripVertical,
  FolderInput,
  FolderOutput,
  Pencil,
  Share2,
  Lock,
  Unlock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileItem as FileItemType, Folder } from "@/types";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";

interface FileItemProps {
  file: FileItemType;
  folders: Folder[];
  onDelete: () => void;
  onRename: () => void;
  onDownload: () => void;
  onShare: () => void;
  onMoveToFolder: (folderId: number | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  locked?: boolean;
  onLock?: () => void;
  onUnlock?: () => void;
}

export function FileItemRow({
  file,
  folders,
  onDelete,
  onRename,
  onDownload,
  onShare,
  onMoveToFolder,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  isSelected,
  onToggleSelect,
  locked,
  onLock,
  onUnlock,
}: FileItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: `file-${file.id}`,
    data: {
      type: "file",
      fileId: file.id,
      folderId: file.folderId ?? null,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const otherFolders = folders.filter((f) => f.id !== file.folderId);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-lg border bg-card transition-colors hover:bg-accent/50 active:bg-accent/70",
        isDragging && "opacity-50 shadow-lg",
        isOver && !isDragging && "border-primary/60 bg-primary/5"
      )}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggleSelect}
        className="h-4 w-4 accent-primary"
        aria-label={`Select ${file.originalName}`}
      />
      {/* Drag handle - hidden on small mobile, visible on larger screens */}
      <button
        className="hidden sm:block cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground p-1"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* File icon */}
      <div className="p-1.5 sm:p-2 rounded-md bg-muted shrink-0">
        <File className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />
      </div>

      {/* File info */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="font-medium text-sm sm:text-base flex items-center gap-1 min-w-0">
          <span className="truncate" title={file.originalName}>{file.originalName}</span>
          {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        </p>
        <p className="text-xs sm:text-sm text-muted-foreground">
          {file.sizeFormatted} • {file.totalParts} part{file.totalParts > 1 ? "s" : ""}
        </p>
      </div>

      {/* Download button - icon only on mobile */}
      <Button
        variant="outline"
        size="sm"
        onClick={onDownload}
        className="gap-1.5 sm:gap-2 h-9 sm:h-8 px-2.5 sm:px-3"
      >
        <Download className="h-4 w-4" />
        <span className="hidden sm:inline">Download</span>
      </Button>

      {/* More actions dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-9 w-9 sm:h-8 sm:w-8 shrink-0">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="h-4 w-4 mr-2" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onShare}>
            <Share2 className="h-4 w-4 mr-2" />
            Share Link
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Reorder options - always accessible via menu */}
          <DropdownMenuItem onClick={onMoveUp} disabled={isFirst}>
            <ChevronUp className="h-4 w-4 mr-2" />
            Move Up
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onMoveDown} disabled={isLast}>
            <ChevronDown className="h-4 w-4 mr-2" />
            Move Down
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {file.folderId !== null && (
            <DropdownMenuItem onClick={() => onMoveToFolder(null)}>
              <FolderOutput className="h-4 w-4 mr-2" />
              Move to Root
            </DropdownMenuItem>
          )}

          {otherFolders.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput className="h-4 w-4 mr-2" />
                Move to Folder
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {otherFolders.map((folder) => (
                  <DropdownMenuItem key={folder.id} onClick={() => onMoveToFolder(folder.id)}>
                    {folder.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuSeparator />

          {locked ? (
            <DropdownMenuItem onClick={onUnlock}>
              <Unlock className="h-4 w-4 mr-2" />
              Unlock (remove password)
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={onLock}>
              <Lock className="h-4 w-4 mr-2" />
              Lock (set password)
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={onDelete} className="text-destructive">
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
