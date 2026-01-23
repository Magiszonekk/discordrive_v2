import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Dimensions,
  Share,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useMedia } from '@/providers/MediaProvider';
import type { LocalMediaItem } from '@discordrive/shared/types';
import * as db from '@/lib/storage/database';

const { width, height } = Dimensions.get('window');

export default function PhotoViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { toggleFavorite } = useMedia();
  const [media, setMedia] = useState<LocalMediaItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadMedia();
  }, [id]);

  async function loadMedia() {
    if (!id) return;

    setIsLoading(true);
    try {
      const item = await db.getMediaById(parseInt(id, 10));
      setMedia(item);
      if (item) {
        await db.updateLastViewed(item.id);
      }
    } catch (error) {
      console.error('Failed to load media:', error);
    } finally {
      setIsLoading(false);
    }
  }

  const handleFavorite = useCallback(async () => {
    if (!media) return;
    await toggleFavorite(media.id);
    setMedia(prev => (prev ? { ...prev, favorite: !prev.favorite } : null));
  }, [media, toggleFavorite]);

  const handleShare = useCallback(async () => {
    if (!media) return;
    try {
      await Share.share({
        message: `Check out ${media.originalName}`,
      });
    } catch (error) {
      console.error('Share failed:', error);
    }
  }, [media]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (!media) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Media not found</Text>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const imageUri = media.thumbnailPath
    ? `file://${media.thumbnailPath}`
    : undefined;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>

        <View style={styles.headerActions}>
          <Pressable onPress={handleFavorite} style={styles.headerButton}>
            <Ionicons
              name={media.favorite ? 'heart' : 'heart-outline'}
              size={24}
              color={media.favorite ? '#ff4444' : '#fff'}
            />
          </Pressable>
          <Pressable onPress={handleShare} style={styles.headerButton}>
            <Ionicons name="share-outline" size={24} color="#fff" />
          </Pressable>
        </View>
      </View>

      {/* Image */}
      <View style={styles.imageContainer}>
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={styles.image}
            contentFit="contain"
            transition={200}
          />
        ) : (
          <View style={styles.placeholder}>
            <Ionicons
              name={media.mimeType.startsWith('video/') ? 'videocam' : 'image'}
              size={64}
              color="#666"
            />
            <Text style={styles.placeholderText}>
              {media.mimeType.startsWith('video/')
                ? 'Video preview not available'
                : 'Loading...'}
            </Text>
          </View>
        )}
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.filename} numberOfLines={2}>
          {media.originalName}
        </Text>
        <View style={styles.metadata}>
          <Text style={styles.metadataText}>
            {formatFileSize(media.size)}
          </Text>
          {media.mediaWidth && media.mediaHeight && (
            <Text style={styles.metadataText}>
              {media.mediaWidth} x {media.mediaHeight}
            </Text>
          )}
          <Text style={styles.metadataText}>
            {new Date(media.createdAt).toLocaleDateString()}
          </Text>
        </View>
      </View>
    </View>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 16,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  headerButton: {
    padding: 8,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  imageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width,
    height: height * 0.7,
  },
  placeholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: '#666',
    marginTop: 16,
  },
  footer: {
    padding: 16,
    paddingBottom: 40,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  filename: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  metadata: {
    flexDirection: 'row',
    gap: 16,
  },
  metadataText: {
    color: '#888',
    fontSize: 12,
  },
  errorText: {
    color: '#ff4444',
    fontSize: 16,
    marginBottom: 16,
  },
  backButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#333',
    borderRadius: 8,
  },
  backButtonText: {
    color: '#fff',
    fontSize: 14,
  },
});
