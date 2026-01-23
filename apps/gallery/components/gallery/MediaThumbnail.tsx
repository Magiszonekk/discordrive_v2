import { useState, useEffect } from 'react';
import { View, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import type { LocalMediaItem } from '@discordrive/shared/types';
import { useThumbnail } from '@/hooks/useThumbnail';

interface Props {
  media: LocalMediaItem;
  size: number;
  onPress: () => void;
  onLongPress?: () => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
}

export function MediaThumbnail({
  media,
  size,
  onPress,
  onLongPress,
  isSelectionMode = false,
  isSelected = false,
}: Props) {
  const { thumbnailUri, isGenerating, error } = useThumbnail(media);

  const isVideo = media.mimeType.startsWith('video/');
  const isImage = media.mimeType.startsWith('image/');

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={500}
      style={[
        styles.container,
        { width: size, height: size },
        isSelected && styles.selectedContainer,
      ]}
    >
      {thumbnailUri ? (
        <Image
          source={{ uri: thumbnailUri }}
          style={[
            styles.image,
            { width: size, height: size },
            isSelected && styles.selectedImage,
          ]}
          contentFit="cover"
          transition={200}
          cachePolicy="memory-disk"
        />
      ) : isGenerating ? (
        <View style={[styles.placeholder, { width: size, height: size }]}>
          <ActivityIndicator size="small" color="#666" />
        </View>
      ) : (
        <View style={[styles.placeholder, { width: size, height: size }]}>
          <Ionicons
            name={isVideo ? 'videocam' : isImage ? 'image' : 'document'}
            size={24}
            color="#666"
          />
        </View>
      )}

      {/* Video indicator */}
      {isVideo && thumbnailUri && !isSelectionMode && (
        <View style={styles.videoIndicator}>
          <Ionicons name="play" size={16} color="#fff" />
        </View>
      )}

      {/* Favorite indicator */}
      {media.favorite && !isSelectionMode && (
        <View style={styles.favoriteIndicator}>
          <Ionicons name="heart" size={12} color="#ff4444" />
        </View>
      )}

      {/* Selection checkbox */}
      {isSelectionMode && (
        <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
          {isSelected && (
            <Ionicons name="checkmark" size={14} color="#fff" />
          )}
        </View>
      )}

      {/* Selected overlay */}
      {isSelected && (
        <View style={styles.selectedOverlay} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a1a',
    position: 'relative',
  },
  selectedContainer: {
    borderWidth: 3,
    borderColor: '#2196F3',
  },
  image: {
    backgroundColor: '#1a1a1a',
  },
  selectedImage: {
    opacity: 0.7,
  },
  placeholder: {
    backgroundColor: '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoIndicator: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 12,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  favoriteIndicator: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 10,
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkbox: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxSelected: {
    backgroundColor: '#2196F3',
    borderColor: '#2196F3',
  },
  selectedOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(33, 150, 243, 0.2)',
  },
});
