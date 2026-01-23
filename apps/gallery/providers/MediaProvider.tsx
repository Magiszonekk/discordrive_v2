import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  PropsWithChildren,
} from 'react';
import type { LocalMediaItem } from '@discordrive/shared/types';
import * as db from '@/lib/storage/database';
import { galleryApi } from '@/lib/api/client';

interface MediaContextType {
  media: LocalMediaItem[];
  isLoading: boolean;
  loadMedia: (folderId?: number | null) => Promise<void>;
  getMediaById: (id: number) => Promise<LocalMediaItem | null>;
  updateThumbnailPath: (id: number, path: string) => Promise<void>;
  toggleFavorite: (id: number) => Promise<void>;
  deleteMedia: (id: number) => Promise<void>;
  clearAllMedia: () => Promise<void>;
}

const MediaContext = createContext<MediaContextType | null>(null);

export function useMedia() {
  const context = useContext(MediaContext);
  if (!context) {
    throw new Error('useMedia must be used within MediaProvider');
  }
  return context;
}

export function MediaProvider({ children }: PropsWithChildren) {
  const [media, setMedia] = useState<LocalMediaItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDbInitialized, setIsDbInitialized] = useState(false);

  // Initialize database on mount
  useEffect(() => {
    db.initDatabase()
      .then(() => {
        setIsDbInitialized(true);
      })
      .catch(error => {
        console.error('Failed to initialize database:', error);
      });
  }, []);

  const loadMedia = useCallback(async (folderId?: number | null) => {
    setIsLoading(true);
    try {
      const items = await db.getAllMedia(folderId);
      setMedia(items);
    } catch (error) {
      console.error('Failed to load media:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const getMediaById = useCallback(async (id: number) => {
    return db.getMediaById(id);
  }, []);

  const updateThumbnailPath = useCallback(async (id: number, path: string) => {
    await db.updateThumbnailPath(id, path);
    setMedia(prev =>
      prev.map(item =>
        item.id === id
          ? { ...item, thumbnailPath: path, thumbnailGeneratedAt: new Date().toISOString() }
          : item
      )
    );
  }, []);

  const toggleFavorite = useCallback(async (id: number) => {
    const item = await db.getMediaById(id);
    if (item) {
      await db.updateFavorite(id, !item.favorite);
      setMedia(prev =>
        prev.map(m => (m.id === id ? { ...m, favorite: !m.favorite } : m))
      );
    }
  }, []);

  const deleteMedia = useCallback(async (id: number) => {
    // Delete from server first
    await galleryApi.deleteFile(id);
    // Then delete from local database
    await db.deleteMedia(id);
    // Update state
    setMedia(prev => prev.filter(m => m.id !== id));
  }, []);

  const clearAllMedia = useCallback(async () => {
    await db.deleteAllMedia();
    setMedia([]);
  }, []);

  // Don't render children until database is initialized
  if (!isDbInitialized) {
    return null;
  }

  return (
    <MediaContext.Provider
      value={{
        media,
        isLoading,
        loadMedia,
        getMediaById,
        updateThumbnailPath,
        toggleFavorite,
        deleteMedia,
        clearAllMedia,
      }}
    >
      {children}
    </MediaContext.Provider>
  );
}
