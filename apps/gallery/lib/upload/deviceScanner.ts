import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';

export interface DeviceMediaItem {
  id: string;
  uri: string;
  filename: string;
  mediaType: 'photo' | 'video';
  width: number;
  height: number;
  duration?: number;
  creationTime: number;
  modificationTime?: number;
  fileSize?: number;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  status: 'scanning' | 'complete' | 'error';
  error?: string;
}

// Helper to get file size with fallback
async function getFileSizeWithFallback(
  localUri: string,
  mediaLibrarySize: number | undefined
): Promise<number | undefined> {
  // If MediaLibrary returned a valid size, use it
  if (mediaLibrarySize && mediaLibrarySize > 0) {
    return mediaLibrarySize;
  }

  // Fallback: try FileSystem.getInfoAsync
  // This works for file:// URIs but not content:// URIs
  if (localUri.startsWith('file://')) {
    try {
      const info = await FileSystem.getInfoAsync(localUri);
      if (info.exists && 'size' in info && info.size && info.size > 0) {
        return info.size;
      }
    } catch {
      // Ignore errors
    }
  }

  return undefined;
}

export class DeviceMediaScanner {
  private aborted = false;

  /**
   * Request permissions to access media library
   */
  async requestPermissions(): Promise<boolean> {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    return status === 'granted';
  }

  /**
   * Check if we have permissions
   */
  async hasPermissions(): Promise<boolean> {
    const { status } = await MediaLibrary.getPermissionsAsync();
    return status === 'granted';
  }

  /**
   * Get all photos and videos from device
   */
  async scanAllMedia(
    onProgress?: (progress: ScanProgress) => void
  ): Promise<DeviceMediaItem[]> {
    this.aborted = false;

    // Check permissions
    const hasPermission = await this.hasPermissions();
    if (!hasPermission) {
      throw new Error('Media library permission not granted');
    }

    const allMedia: DeviceMediaItem[] = [];
    let hasNextPage = true;
    let endCursor: string | undefined;
    const pageSize = 100;

    try {
      // Get total count first
      const albumInfo = await MediaLibrary.getAlbumAsync('All');
      const totalCount = albumInfo?.assetCount ?? 0;

      while (hasNextPage && !this.aborted) {
        const assets = await MediaLibrary.getAssetsAsync({
          first: pageSize,
          after: endCursor,
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [MediaLibrary.SortBy.creationTime],
        });

        for (const asset of assets.assets) {
          if (this.aborted) break;

          // Get detailed asset info including file size
          let mediaLibrarySize: number | undefined;
          let localUri: string = asset.uri;
          try {
            const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
            if (assetInfo) {
              mediaLibrarySize = assetInfo.fileSize;
              // Use localUri if available (actual file path)
              if (assetInfo.localUri) {
                localUri = assetInfo.localUri;
              }
            }
          } catch {
            // Ignore asset info errors
          }

          // Get file size with fallback
          const fileSize = await getFileSizeWithFallback(localUri, mediaLibrarySize);

          allMedia.push({
            id: asset.id,
            uri: localUri,
            filename: asset.filename,
            mediaType: asset.mediaType === MediaLibrary.MediaType.video ? 'video' : 'photo',
            width: asset.width,
            height: asset.height,
            duration: asset.duration,
            creationTime: asset.creationTime,
            modificationTime: asset.modificationTime,
            fileSize,
          });
        }

        hasNextPage = assets.hasNextPage;
        endCursor = assets.endCursor;

        if (onProgress) {
          onProgress({
            scanned: allMedia.length,
            total: totalCount,
            status: hasNextPage ? 'scanning' : 'complete',
          });
        }
      }

      if (onProgress) {
        onProgress({
          scanned: allMedia.length,
          total: allMedia.length,
          status: 'complete',
        });
      }

      return allMedia;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to scan media';
      if (onProgress) {
        onProgress({
          scanned: allMedia.length,
          total: allMedia.length,
          status: 'error',
          error: errorMessage,
        });
      }
      throw error;
    }
  }

  /**
   * Get only photos from device
   */
  async scanPhotos(
    onProgress?: (progress: ScanProgress) => void
  ): Promise<DeviceMediaItem[]> {
    this.aborted = false;

    const hasPermission = await this.hasPermissions();
    if (!hasPermission) {
      throw new Error('Media library permission not granted');
    }

    const allPhotos: DeviceMediaItem[] = [];
    let hasNextPage = true;
    let endCursor: string | undefined;
    const pageSize = 100;

    try {
      while (hasNextPage && !this.aborted) {
        const assets = await MediaLibrary.getAssetsAsync({
          first: pageSize,
          after: endCursor,
          mediaType: MediaLibrary.MediaType.photo,
          sortBy: [MediaLibrary.SortBy.creationTime],
        });

        for (const asset of assets.assets) {
          if (this.aborted) break;

          let mediaLibrarySize: number | undefined;
          let localUri: string = asset.uri;
          try {
            const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
            if (assetInfo) {
              mediaLibrarySize = assetInfo.fileSize;
              if (assetInfo.localUri) {
                localUri = assetInfo.localUri;
              }
            }
          } catch {
            // Ignore
          }

          const fileSize = await getFileSizeWithFallback(localUri, mediaLibrarySize);

          allPhotos.push({
            id: asset.id,
            uri: localUri,
            filename: asset.filename,
            mediaType: 'photo',
            width: asset.width,
            height: asset.height,
            creationTime: asset.creationTime,
            modificationTime: asset.modificationTime,
            fileSize,
          });
        }

        hasNextPage = assets.hasNextPage;
        endCursor = assets.endCursor;

        if (onProgress) {
          onProgress({
            scanned: allPhotos.length,
            total: allPhotos.length, // We don't know total for filtered query
            status: hasNextPage ? 'scanning' : 'complete',
          });
        }
      }

      return allPhotos;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to scan photos';
      if (onProgress) {
        onProgress({
          scanned: allPhotos.length,
          total: allPhotos.length,
          status: 'error',
          error: errorMessage,
        });
      }
      throw error;
    }
  }

  /**
   * Get only videos from device
   */
  async scanVideos(
    onProgress?: (progress: ScanProgress) => void
  ): Promise<DeviceMediaItem[]> {
    this.aborted = false;

    const hasPermission = await this.hasPermissions();
    if (!hasPermission) {
      throw new Error('Media library permission not granted');
    }

    const allVideos: DeviceMediaItem[] = [];
    let hasNextPage = true;
    let endCursor: string | undefined;
    const pageSize = 100;

    try {
      while (hasNextPage && !this.aborted) {
        const assets = await MediaLibrary.getAssetsAsync({
          first: pageSize,
          after: endCursor,
          mediaType: MediaLibrary.MediaType.video,
          sortBy: [MediaLibrary.SortBy.creationTime],
        });

        for (const asset of assets.assets) {
          if (this.aborted) break;

          let mediaLibrarySize: number | undefined;
          let localUri: string = asset.uri;
          try {
            const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
            if (assetInfo) {
              mediaLibrarySize = assetInfo.fileSize;
              if (assetInfo.localUri) {
                localUri = assetInfo.localUri;
              }
            }
          } catch {
            // Ignore
          }

          const fileSize = await getFileSizeWithFallback(localUri, mediaLibrarySize);

          allVideos.push({
            id: asset.id,
            uri: localUri,
            filename: asset.filename,
            mediaType: 'video',
            width: asset.width,
            height: asset.height,
            duration: asset.duration,
            creationTime: asset.creationTime,
            modificationTime: asset.modificationTime,
            fileSize,
          });
        }

        hasNextPage = assets.hasNextPage;
        endCursor = assets.endCursor;

        if (onProgress) {
          onProgress({
            scanned: allVideos.length,
            total: allVideos.length,
            status: hasNextPage ? 'scanning' : 'complete',
          });
        }
      }

      return allVideos;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to scan videos';
      if (onProgress) {
        onProgress({
          scanned: allVideos.length,
          total: allVideos.length,
          status: 'error',
          error: errorMessage,
        });
      }
      throw error;
    }
  }

  /**
   * Abort the current scan
   */
  abort() {
    this.aborted = true;
  }
}
