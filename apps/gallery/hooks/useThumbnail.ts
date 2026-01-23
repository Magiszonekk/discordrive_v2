import { useState, useEffect, useRef } from 'react';
import * as FileSystem from 'expo-file-system';
import type { LocalMediaItem } from '@discordrive/shared/types';
import { generateThumbnail } from '@/lib/crypto/thumbnail';
import { useMedia } from '@/providers/MediaProvider';

interface ThumbnailState {
  thumbnailUri: string | null;
  isGenerating: boolean;
  error: Error | null;
}

export function useThumbnail(media: LocalMediaItem): ThumbnailState {
  const [state, setState] = useState<ThumbnailState>({
    thumbnailUri: media.thumbnailPath ? `file://${media.thumbnailPath}` : null,
    isGenerating: false,
    error: null,
  });
  const { updateThumbnailPath } = useMedia();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadOrGenerate() {
      // If we already have a thumbnail path, check if file exists
      if (media.thumbnailPath) {
        try {
          const info = await FileSystem.getInfoAsync(media.thumbnailPath);
          if (info.exists) {
            if (!cancelled && mountedRef.current) {
              setState({
                thumbnailUri: `file://${media.thumbnailPath}`,
                isGenerating: false,
                error: null,
              });
            }
            return;
          }
        } catch {
          // File doesn't exist, need to regenerate
        }
      }

      // Skip thumbnail generation for non-image files for now
      // Video thumbnail extraction is more complex
      if (!media.mimeType.startsWith('image/')) {
        return;
      }

      // Generate thumbnail
      if (!cancelled && mountedRef.current) {
        setState(prev => ({ ...prev, isGenerating: true, error: null }));
      }

      try {
        const path = await generateThumbnail({
          mediaId: media.id,
          mimeType: media.mimeType,
          encryptionHeader: media.encryptionHeader,
          firstPartIv: media.firstPartIv,
          firstPartAuthTag: media.firstPartAuthTag,
        });

        if (!cancelled && mountedRef.current) {
          await updateThumbnailPath(media.id, path);
          setState({
            thumbnailUri: `file://${path}`,
            isGenerating: false,
            error: null,
          });
        }
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          setState(prev => ({
            ...prev,
            isGenerating: false,
            error: err instanceof Error ? err : new Error('Failed to generate thumbnail'),
          }));
        }
      }
    }

    loadOrGenerate();

    return () => {
      cancelled = true;
    };
  }, [media.id, media.thumbnailPath, media.mimeType]);

  return state;
}
