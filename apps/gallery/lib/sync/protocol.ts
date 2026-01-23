import type { GalleryMediaItem } from '@discordrive/shared/types';
import { galleryApi } from '@/lib/api/client';
import * as db from '@/lib/storage/database';
import { syncThumbnails } from '@/lib/crypto/thumbnail';

interface SyncCallbacks {
  onProgress: (progress: number) => void;
  onComplete: (result: SyncResult) => void;
  onError: (error: Error) => void;
}

interface SyncResult {
  newItems: number;
  updatedItems: number;
  deletedItems: number;
  totalProcessed: number;
  syncToken: string | null;
}

export class GallerySync {
  private callbacks: SyncCallbacks;
  private isSyncing = false;

  constructor(callbacks: SyncCallbacks) {
    this.callbacks = callbacks;
  }

  async performSync(): Promise<SyncResult> {
    if (this.isSyncing) {
      throw new Error('Sync already in progress');
    }

    this.isSyncing = true;
    let result: SyncResult = {
      newItems: 0,
      updatedItems: 0,
      deletedItems: 0,
      totalProcessed: 0,
      syncToken: null,
    };

    try {
      // Get current sync state
      const syncState = await db.getSyncState();

      // Fetch changes from server
      const response = await galleryApi.getSync({
        since: syncState.lastSyncAt || undefined,
        limit: 100,
      });

      if (!response.success) {
        throw new Error('Failed to fetch sync data');
      }

      const totalItems = response.files.length;
      let processed = 0;

      // Process each item
      for (const serverItem of response.files) {
        const localItem = await db.getMediaById(serverItem.id);

        if (!localItem) {
          // New item
          await db.upsertMedia(serverItem);
          result.newItems++;
        } else {
          // Existing item - update metadata
          await db.upsertMedia(serverItem);
          result.updatedItems++;
        }

        processed++;
        result.totalProcessed = processed;
        this.callbacks.onProgress(processed / Math.max(totalItems, 1));
      }

      // Handle deletions if we did a full sync (no since parameter)
      if (!syncState.lastSyncAt && response.files.length > 0) {
        const serverIds = new Set(response.files.map(f => f.id));
        const localIds = await db.getAllMediaIds();

        for (const localId of localIds) {
          if (!serverIds.has(localId)) {
            await db.deleteMedia(localId);
            result.deletedItems++;
          }
        }
      }

      // Update sync state
      result.syncToken = response.syncToken;
      await db.updateSyncState(response.syncToken, result.totalProcessed);

      // Acknowledge sync
      if (response.syncToken) {
        await galleryApi.ackSync(response.syncToken).catch(() => {
          // Don't fail sync if ack fails
        });
      }

      // Sync thumbnails in background (upload local, download missing)
      syncThumbnails().catch((err) => {
        console.log('Background thumbnail sync error:', err);
      });

      this.callbacks.onComplete(result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Sync failed');
      this.callbacks.onError(err);
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  async fullSync(): Promise<SyncResult> {
    if (this.isSyncing) {
      throw new Error('Sync already in progress');
    }

    this.isSyncing = true;

    let result: SyncResult = {
      newItems: 0,
      updatedItems: 0,
      deletedItems: 0,
      totalProcessed: 0,
      syncToken: null,
    };

    try {
      // Clear local sync state for full sync
      await db.updateSyncState(null, 0);

      let hasMore = true;
      let allServerIds: number[] = [];

      while (hasMore) {
        const response = await galleryApi.getSync({
          limit: 100,
        });

        if (!response.success) {
          throw new Error('Failed to fetch sync data');
        }

        // Process items
        for (const serverItem of response.files) {
          allServerIds.push(serverItem.id);
          const localItem = await db.getMediaById(serverItem.id);

          if (!localItem) {
            await db.upsertMedia(serverItem);
            result.newItems++;
          } else {
            await db.upsertMedia(serverItem);
            result.updatedItems++;
          }

          result.totalProcessed++;
        }

        hasMore = response.hasMore;
        result.syncToken = response.syncToken;

        // Update progress
        this.callbacks.onProgress(hasMore ? 0.9 : 1);
      }

      // Handle deletions
      const serverIdSet = new Set(allServerIds);
      const localIds = await db.getAllMediaIds();

      for (const localId of localIds) {
        if (!serverIdSet.has(localId)) {
          await db.deleteMedia(localId);
          result.deletedItems++;
        }
      }

      // Update sync state
      await db.updateSyncState(result.syncToken, result.totalProcessed);

      // Sync thumbnails in background (upload local, download missing)
      syncThumbnails().catch((err) => {
        console.log('Background thumbnail sync error:', err);
      });

      this.callbacks.onComplete(result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Sync failed');
      this.callbacks.onError(err);
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }
}
