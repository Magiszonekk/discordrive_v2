import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  PropsWithChildren,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { GallerySyncState } from '@discordrive/shared/types';
import { GallerySync } from '@/lib/sync/protocol';
import { useMedia } from './MediaProvider';

interface SyncContextType {
  syncState: GallerySyncState;
  isOnline: boolean;
  triggerSync: () => Promise<void>;
  fullSync: () => Promise<void>;
}

const SyncContext = createContext<SyncContextType | null>(null);

export function useSync() {
  const context = useContext(SyncContext);
  if (!context) {
    throw new Error('useSync must be used within SyncProvider');
  }
  return context;
}

const initialSyncState: GallerySyncState = {
  status: 'idle',
  lastSync: null,
  syncToken: null,
  totalItems: 0,
  pendingItems: 0,
  progress: 0,
};

export function SyncProvider({ children }: PropsWithChildren) {
  const [syncState, setSyncState] = useState<GallerySyncState>(initialSyncState);
  const [isOnline, setIsOnline] = useState(true);
  const syncRef = useRef<GallerySync | null>(null);
  const { loadMedia } = useMedia();

  // Initialize sync manager
  useEffect(() => {
    syncRef.current = new GallerySync({
      onProgress: (progress) => {
        setSyncState(prev => ({
          ...prev,
          progress,
          pendingItems: Math.max(0, prev.totalItems - Math.floor(prev.totalItems * progress)),
        }));
      },
      onComplete: async (result) => {
        setSyncState(prev => ({
          ...prev,
          status: 'idle',
          lastSync: new Date(),
          syncToken: result.syncToken,
          totalItems: result.totalProcessed,
          pendingItems: 0,
          progress: 1,
        }));
        // Reload media after sync
        await loadMedia();
      },
      onError: (error) => {
        setSyncState(prev => ({
          ...prev,
          status: 'error',
          error: error.message,
        }));
      },
    });
  }, [loadMedia]);

  // Monitor network state
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsOnline(state.isConnected ?? false);
    });
    return () => unsubscribe();
  }, []);

  const triggerSync = useCallback(async () => {
    if (!syncRef.current || syncState.status === 'syncing' || !isOnline) {
      return;
    }

    setSyncState(prev => ({
      ...prev,
      status: 'syncing',
      progress: 0,
      error: undefined,
    }));

    try {
      await syncRef.current.performSync();
    } catch (error) {
      console.error('Sync failed:', error);
      setSyncState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Sync failed',
      }));
    }
  }, [syncState.status, isOnline]);

  // Auto-sync when app comes to foreground
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active' && isOnline && syncState.status === 'idle') {
        triggerSync();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [isOnline, syncState.status, triggerSync]);

  const fullSync = useCallback(async () => {
    if (!syncRef.current || syncState.status === 'syncing' || !isOnline) {
      return;
    }

    setSyncState(prev => ({
      ...prev,
      status: 'syncing',
      progress: 0,
      totalItems: 0,
      error: undefined,
    }));

    try {
      await syncRef.current.fullSync();
    } catch (error) {
      console.error('Full sync failed:', error);
      setSyncState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Sync failed',
      }));
    }
  }, [syncState.status, isOnline]);

  return (
    <SyncContext.Provider
      value={{
        syncState,
        isOnline,
        triggerSync,
        fullSync,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}
