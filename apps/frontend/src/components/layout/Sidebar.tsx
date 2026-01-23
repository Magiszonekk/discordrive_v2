"use client";

import { useState } from "react";
import {
  Folder,
  FolderPlus,
  Home,
  ChevronUp,
  ChevronDown,
  MoreVertical,
  Pencil,
  Trash2,
  HardDrive,
  Share2,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useReorderFolders } from "@/hooks/useFolders";
import { Folder as FolderType } from "@/types";
import { cn } from "@/lib/utils";
import { CreateFolderDialog } from "@/components/folders/CreateFolderDialog";
import { RenameFolderDialog } from "@/components/folders/RenameFolderDialog";
import { DeleteFolderDialog } from "@/components/folders/DeleteFolderDialog";
import { useDroppable } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import { getStorageStats } from "@/lib/api";
import { ShareDialog } from "@/components/shares/ShareDialog";
import { FolderDownloadDialog } from "@/components/folders/FolderDownloadDialog";

interface SidebarProps {
  currentFolderId: number | null;
  onFolderSelect: (folderId: number | null) => void;
  folders: FolderType[];
  isLoading?: boolean;
  onClose?: () => void; // For mobile - close sidebar after selection
}

function SortableFolderItem({
  folder,
  isActive,
  onSelect,
  onRename,
  onDelete,
  onShare,
  onDownload,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  folder: FolderType;
  isActive: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onShare: () => void;
  onDownload: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: `folder-${folder.id}`,
    data: {
      type: "folder",
      folderId: folder.id,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-2.5 sm:py-1.5 text-sm transition-colors border border-transparent",
        isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50 active:bg-accent/70",
        isDragging && "opacity-50",
        isOver && !isDragging && "border-primary bg-primary/5"
      )}
    >
      <button
        className="flex-1 flex items-center gap-2 text-left cursor-grab active:cursor-grabbing min-w-0"
        onClick={onSelect}
        {...attributes}
        {...listeners}
      >
        <Folder className="h-4 w-4 shrink-0" />
        <span className="truncate flex-1">{folder.name}</span>
        <span className="text-xs text-muted-foreground shrink-0">{folder.file_count}</span>
      </button>

      {/* Actions dropdown - always visible for touch support */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="h-4 w-4 mr-2" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDownload}>
            <Download className="h-4 w-4 mr-2" />
            Download ZIP
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onShare}>
            <Share2 className="h-4 w-4 mr-2" />
            Share
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onMoveUp} disabled={isFirst}>
            <ChevronUp className="h-4 w-4 mr-2" />
            Move Up
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onMoveDown} disabled={isLast}>
            <ChevronDown className="h-4 w-4 mr-2" />
            Move Down
          </DropdownMenuItem>
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

export function Sidebar({ currentFolderId, onFolderSelect, folders, isLoading, onClose }: SidebarProps) {
  const reorderFolders = useReorderFolders();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [renameFolder, setRenameFolder] = useState<FolderType | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<FolderType | null>(null);
  const [shareFolder, setShareFolder] = useState<FolderType | null>(null);
  const [downloadFolder, setDownloadFolder] = useState<FolderType | null>(null);

  const { data: storageStats } = useQuery({
    queryKey: ["storageStats"],
    queryFn: getStorageStats,
    refetchInterval: 30000,
  });

  const { setNodeRef: setRootRef, isOver: isRootOver } = useDroppable({
    id: "root-droppable",
    data: {
      type: "root",
      folderId: null,
    },
  });

  const handleMoveFolder = (folderId: number, direction: "up" | "down") => {
    const index = folders.findIndex((f) => f.id === folderId);
    if (index === -1) return;

    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= folders.length) return;

    const newOrder = arrayMove(folders, index, newIndex);
    reorderFolders.mutate(newOrder.map((f) => f.id));
  };

  const handleFolderSelect = (folderId: number | null) => {
    onFolderSelect(folderId);
    onClose?.(); // Close mobile sidebar on selection
  };

  return (
    <div className="h-full flex flex-col bg-muted/30">
      <div className="p-3 sm:p-4">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 h-10"
          onClick={() => setCreateDialogOpen(true)}
        >
          <FolderPlus className="h-4 w-4" />
          New Folder
        </Button>
      </div>

      <Separator />

      <ScrollArea className="flex-1">
        <div className="p-2">
          <button
            ref={setRootRef}
            onClick={() => handleFolderSelect(null)}
            className={cn(
              "w-full flex items-center gap-2 rounded-md px-2 py-2.5 sm:py-1.5 text-sm transition-colors border border-transparent",
              currentFolderId === null ? "bg-accent text-accent-foreground" : "hover:bg-accent/50 active:bg-accent/70",
              isRootOver && "border-primary bg-primary/5"
            )}
          >
            <Home className="h-4 w-4" />
            <span>All Files</span>
          </button>

          {folders.length > 0 && (
            <>
              <Separator className="my-2" />
              <SortableContext items={folders.map((f) => `folder-${f.id}`)} strategy={verticalListSortingStrategy}>
                <div className="space-y-0.5">
                  {folders.map((folder, index) => (
                    <SortableFolderItem
                      key={folder.id}
                      folder={folder}
                      isActive={currentFolderId === folder.id}
                      onSelect={() => handleFolderSelect(folder.id)}
                      onRename={() => setRenameFolder(folder)}
                      onDelete={() => setDeleteFolder(folder)}
                      onShare={() => setShareFolder(folder)}
                      onDownload={() => setDownloadFolder(folder)}
                      onMoveUp={() => handleMoveFolder(folder.id, "up")}
                      onMoveDown={() => handleMoveFolder(folder.id, "down")}
                      isFirst={index === 0}
                      isLast={index === folders.length - 1}
                    />
                  ))}
                </div>
              </SortableContext>
            </>
          )}

          {isLoading && (
            <div className="space-y-2 mt-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 sm:h-8 bg-muted animate-pulse rounded-md" />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {storageStats && (
        <>
          <Separator />
          <div className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <HardDrive className="h-4 w-4" />
              <div>
                <span className="font-medium text-foreground">{storageStats.totalSizeFormatted}</span>
                <span className="ml-1">stored</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {storageStats.totalFiles} file{storageStats.totalFiles !== 1 ? "s" : ""}
            </p>
          </div>
        </>
      )}

      <CreateFolderDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />

      {renameFolder && (
        <RenameFolderDialog
          folder={renameFolder}
          open={!!renameFolder}
          onOpenChange={(open) => !open && setRenameFolder(null)}
        />
      )}

      {deleteFolder && (
        <DeleteFolderDialog
          folder={deleteFolder}
          open={!!deleteFolder}
          onOpenChange={(open) => !open && setDeleteFolder(null)}
          onDeleted={() => {
            if (currentFolderId === deleteFolder.id) {
              onFolderSelect(null);
            }
          }}
        />
      )}

      {shareFolder && (
        <ShareDialog
          resourceType="folder"
          resourceId={shareFolder.id}
          resourceName={shareFolder.name}
          open={!!shareFolder}
          onOpenChange={(open) => {
            if (!open) setShareFolder(null);
          }}
        />
      )}

      {downloadFolder && (
        <FolderDownloadDialog
          folder={downloadFolder}
          fileCountOverride={downloadFolder.file_count}
          open={!!downloadFolder}
          onOpenChange={(open) => {
            if (!open) setDownloadFolder(null);
          }}
        />
      )}
    </div>
  );
}
