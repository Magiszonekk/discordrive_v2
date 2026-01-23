"use client";

import { useCallback, useMemo, useState } from "react";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { FileUpload } from "@/components/files/FileUpload";
import { FileList } from "@/components/files/FileList";
import { useFiles, useDeleteFile, useUpdateFile, useReorderFiles } from "@/hooks/useFiles";
import { useFolders, useReorderFolders } from "@/hooks/useFolders";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates, arrayMove } from "@dnd-kit/sortable";
import { toast } from "sonner";
import { ShareDialog } from "@/components/shares/ShareDialog";
import { FolderDownloadDialog } from "@/components/folders/FolderDownloadDialog";
import { Download, Share2 } from "lucide-react";

export default function HomePage() {
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [folderShareOpen, setFolderShareOpen] = useState(false);
  const [folderDownloadOpen, setFolderDownloadOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const filesQuery = useFiles(currentFolderId);
  const foldersQuery = useFolders();
  const updateFile = useUpdateFile();
  const deleteFile = useDeleteFile();
  const reorderFiles = useReorderFiles();
  const reorderFolders = useReorderFolders();

  const files = useMemo(() => filesQuery.data?.files ?? [], [filesQuery.data]);
  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const activeFolder = useMemo(
    () => (currentFolderId ? folders.find((folder) => folder.id === currentFolderId) ?? null : null),
    [currentFolderId, folders]
  );
  const folderFiles = useMemo(() => (activeFolder ? files : []), [activeFolder, files]);

  const folderTitle = activeFolder ? activeFolder.name : "All Files";
  const folderDescription = activeFolder
    ? `${activeFolder.file_count} file${activeFolder.file_count === 1 ? "" : "s"} in this folder`
    : "Files stored outside of folders";

  const handleFileMove = useCallback(
    async (fileId: number, folderId: number | null) => {
      await updateFile.mutateAsync({ id: fileId, data: { folderId } });
    },
    [updateFile]
  );

  const handleFileDelete = useCallback(async (fileId: number) => {
    await deleteFile.mutateAsync(fileId);
  }, [deleteFile]);

  const handleFileReorder = useCallback(
    async (orderedIds: number[], folderId: number | null) => {
      await reorderFiles.mutateAsync({ folderId, orderedIds });
    },
    [reorderFiles]
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeType = active.data.current?.type as string | undefined;
      const overType = over.data.current?.type as string | undefined;

      if (activeType === "folder" && overType === "folder") {
        const activeId = active.data.current?.folderId as number | undefined;
        const overId = over.data.current?.folderId as number | undefined;
        if (activeId == null || overId == null || activeId === overId) return;

        const oldIndex = folders.findIndex((folder) => folder.id === activeId);
        const newIndex = folders.findIndex((folder) => folder.id === overId);
        if (oldIndex === -1 || newIndex === -1) return;

        const newOrder = arrayMove(folders, oldIndex, newIndex);
        reorderFolders.mutate(newOrder.map((folder) => folder.id));
        return;
      }

      if (activeType === "file") {
        const fileId = active.data.current?.fileId as number | undefined;
        if (fileId == null) return;

        if (overType === "file") {
          const overFileId = over.data.current?.fileId as number | undefined;
          if (overFileId == null || overFileId === fileId) return;

          const oldIndex = files.findIndex((file) => file.id === fileId);
          const newIndex = files.findIndex((file) => file.id === overFileId);
          if (oldIndex === -1 || newIndex === -1) return;

          const newOrder = arrayMove(files, oldIndex, newIndex);
          reorderFiles.mutate({ folderId: currentFolderId, orderedIds: newOrder.map((file) => file.id) });
          return;
        }

        if (overType === "folder" || overType === "root") {
          const targetFolderId = overType === "folder" ? (over.data.current?.folderId as number | null) ?? null : null;
          const sourceFolderId = (active.data.current?.folderId as number | null) ?? null;
          if ((sourceFolderId ?? null) === (targetFolderId ?? null)) return;

          try {
            await updateFile.mutateAsync({ id: fileId, data: { folderId: targetFolderId } });
            toast.success(targetFolderId === null ? "File moved to All Files" : "File moved to folder");
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to move file");
          }
        }
      }
    },
    [folders, reorderFolders, files, reorderFiles, currentFolderId, updateFile]
  );

  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      <Header onMenuClick={() => setMobileMenuOpen(true)} />

      {/* Mobile sidebar sheet */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="p-0 w-72">
          <Sidebar
            folders={folders}
            isLoading={foldersQuery.isLoading}
            currentFolderId={currentFolderId}
            onFolderSelect={setCurrentFolderId}
            onClose={() => setMobileMenuOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="flex min-h-[calc(100vh-3.5rem)]">
          {/* Desktop sidebar - hidden on mobile */}
          <div className="hidden lg:block w-64 border-r shrink-0">
            <Sidebar
              folders={folders}
              isLoading={foldersQuery.isLoading}
              currentFolderId={currentFolderId}
              onFolderSelect={setCurrentFolderId}
            />
          </div>

          <main className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6">
            <div className="mx-auto flex max-w-6xl flex-col gap-4 sm:gap-6">
              <section className="rounded-lg border bg-card p-3 sm:p-4 md:p-6">
                <div className="mb-3 sm:mb-4">
                  <h2 className="text-base sm:text-lg font-semibold">Upload files</h2>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    Drag and drop large files and track encrypted uploads in real-time.
                  </p>
                </div>
                <FileUpload folderId={currentFolderId} />
              </section>

              <section className="rounded-lg border bg-card p-3 sm:p-4 md:p-6">
                <div className="mb-3 sm:mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <h2 className="text-base sm:text-lg font-semibold">{folderTitle}</h2>
                    <p className="text-xs sm:text-sm text-muted-foreground">{folderDescription}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {activeFolder && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setFolderDownloadOpen(true)}
                          className="gap-1.5 sm:gap-2 h-9"
                        >
                          <Download className="h-4 w-4" />
                          <span className="hidden xs:inline">Download</span> ZIP
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setFolderShareOpen(true)}
                          className="gap-1.5 sm:gap-2 h-9"
                        >
                          <Share2 className="h-4 w-4" />
                          Share
                        </Button>
                      </>
                    )}
                    <div className="text-xs sm:text-sm text-muted-foreground">
                      {files.length} file{files.length === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>

                <FileList
                  folderId={currentFolderId}
                  folders={folders}
                  files={files}
                  isLoading={filesQuery.isLoading}
                  onMoveFile={handleFileMove}
                  onDeleteFile={handleFileDelete}
                  onReorderFiles={handleFileReorder}
                />
              </section>
            </div>
          </main>
        </div>

        {activeFolder && (
          <>
            <ShareDialog
              resourceType="folder"
              resourceId={activeFolder.id}
              resourceName={activeFolder.name}
              open={folderShareOpen}
              onOpenChange={setFolderShareOpen}
            />
            <FolderDownloadDialog
              folder={activeFolder}
              files={folderFiles}
              open={folderDownloadOpen}
              onOpenChange={setFolderDownloadOpen}
            />
          </>
        )}
      </DndContext>
    </div>
  );
}
