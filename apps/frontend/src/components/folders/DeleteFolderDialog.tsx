"use client";

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
import { useDeleteFolder } from "@/hooks/useFolders";
import { Folder } from "@/types";
import { toast } from "sonner";

interface DeleteFolderDialogProps {
  folder: Folder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

export function DeleteFolderDialog({ folder, open, onOpenChange, onDeleted }: DeleteFolderDialogProps) {
  const deleteFolder = useDeleteFolder();

  const handleDelete = async () => {
    try {
      await deleteFolder.mutateAsync({ id: folder.id, force: true });
      toast.success("Folder deleted");
      onDeleted?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete folder");
    }
  };

  const hasFiles = folder.file_count > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Folder</AlertDialogTitle>
          <AlertDialogDescription>
            {hasFiles ? (
              <>
                This folder contains <strong>{folder.file_count} file{folder.file_count > 1 ? "s" : ""}</strong>.
                Deleting it will permanently remove all files inside. This action cannot be undone.
                <br /><br />
                <strong>Tip:</strong> You can drag files out of this folder before deleting it.
              </>
            ) : (
              <>
                Are you sure you want to delete the folder &quot;{folder.name}&quot;? This action cannot be undone.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={deleteFolder.isPending}
          >
            {deleteFolder.isPending ? "Deleting..." : hasFiles ? "Delete Folder and Files" : "Delete Folder"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
