import {
  createContext,
  useContext,
  useState,
  useCallback,
  PropsWithChildren,
} from 'react';
import type { GalleryFolder } from '@discordrive/shared/types';
import { galleryApi } from '@/lib/api/client';

interface FolderContextType {
  folders: GalleryFolder[];
  currentFolderId: number | null;
  currentFolder: GalleryFolder | null;
  isLoading: boolean;
  loadFolders: () => Promise<void>;
  navigateToFolder: (folderId: number | null) => void;
  createFolder: (name: string) => Promise<GalleryFolder>;
  renameFolder: (folderId: number, name: string) => Promise<void>;
  deleteFolder: (folderId: number) => Promise<void>;
  moveFileToFolder: (fileId: number, folderId: number | null) => Promise<void>;
  rootMediaCount: number;
}

const FolderContext = createContext<FolderContextType | null>(null);

export function useFolders() {
  const context = useContext(FolderContext);
  if (!context) {
    throw new Error('useFolders must be used within FolderProvider');
  }
  return context;
}

export function FolderProvider({ children }: PropsWithChildren) {
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [rootMediaCount, setRootMediaCount] = useState(0);

  const currentFolder = currentFolderId
    ? folders.find(f => f.id === currentFolderId) || null
    : null;

  const loadFolders = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await galleryApi.getFolders();
      setFolders(response.folders);
      setRootMediaCount(response.rootMediaCount);
    } catch (error) {
      console.error('Failed to load folders:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const navigateToFolder = useCallback((folderId: number | null) => {
    setCurrentFolderId(folderId);
  }, []);

  const createFolder = useCallback(async (name: string): Promise<GalleryFolder> => {
    const response = await galleryApi.createFolder(name);
    const newFolder: GalleryFolder = {
      id: response.folder.id,
      name: response.folder.name,
      mediaCount: 0,
      createdAt: new Date().toISOString(),
    };
    setFolders(prev => [...prev, newFolder]);
    return newFolder;
  }, []);

  const renameFolder = useCallback(async (folderId: number, name: string) => {
    await galleryApi.renameFolder(folderId, name);
    setFolders(prev =>
      prev.map(f => (f.id === folderId ? { ...f, name } : f))
    );
  }, []);

  const deleteFolder = useCallback(async (folderId: number) => {
    await galleryApi.deleteFolder(folderId);
    setFolders(prev => prev.filter(f => f.id !== folderId));
    // Navigate back to root if we're in the deleted folder
    if (currentFolderId === folderId) {
      setCurrentFolderId(null);
    }
  }, [currentFolderId]);

  const moveFileToFolder = useCallback(async (fileId: number, folderId: number | null) => {
    await galleryApi.moveFileToFolder(fileId, folderId);
    // Reload folders to update counts
    await loadFolders();
  }, [loadFolders]);

  return (
    <FolderContext.Provider
      value={{
        folders,
        currentFolderId,
        currentFolder,
        isLoading,
        loadFolders,
        navigateToFolder,
        createFolder,
        renameFolder,
        deleteFolder,
        moveFileToFolder,
        rootMediaCount,
      }}
    >
      {children}
    </FolderContext.Provider>
  );
}
