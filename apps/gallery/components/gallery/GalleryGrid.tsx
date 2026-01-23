import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  View,
  Text,
  StyleSheet,
  Dimensions,
  RefreshControl,
  Alert,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMedia } from '@/providers/MediaProvider';
import { useSync } from '@/providers/SyncProvider';
import { useFolders } from '@/providers/FolderProvider';
import { MediaThumbnail } from './MediaThumbnail';
import type { LocalMediaItem } from '@discordrive/shared/types';

const { width } = Dimensions.get('window');
const COLUMNS = 3;
const GAP = 2;
const ITEM_SIZE = (width - GAP * (COLUMNS + 1)) / COLUMNS;

export function GalleryGrid() {
  const router = useRouter();
  const { media, isLoading, loadMedia, deleteMedia } = useMedia();
  const { triggerSync, syncState } = useSync();
  const { currentFolderId, loadFolders } = useFolders();
  const [isDeleting, setIsDeleting] = useState(false);

  // Selection state
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Load folders on mount
  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  // Load media when folder changes
  useEffect(() => {
    loadMedia(currentFolderId);
  }, [loadMedia, currentFolderId]);

  // Exit selection mode when media changes and selection is empty
  useEffect(() => {
    if (isSelectionMode && media.length === 0) {
      setIsSelectionMode(false);
      setSelectedIds(new Set());
    }
  }, [media.length, isSelectionMode]);

  const handlePress = useCallback(
    (item: LocalMediaItem) => {
      if (isSelectionMode) {
        // Toggle selection
        setSelectedIds((prev) => {
          const newSet = new Set(prev);
          if (newSet.has(item.id)) {
            newSet.delete(item.id);
          } else {
            newSet.add(item.id);
          }
          // Exit selection mode if no items selected
          if (newSet.size === 0) {
            setIsSelectionMode(false);
          }
          return newSet;
        });
      } else {
        router.push(`/photo/${item.id}`);
      }
    },
    [router, isSelectionMode]
  );

  const handleLongPress = useCallback(
    (item: LocalMediaItem) => {
      if (!isSelectionMode) {
        // Enter selection mode and select this item
        setIsSelectionMode(true);
        setSelectedIds(new Set([item.id]));
      }
    },
    [isSelectionMode]
  );

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === media.length) {
      // Deselect all
      setSelectedIds(new Set());
      setIsSelectionMode(false);
    } else {
      // Select all
      setSelectedIds(new Set(media.map((m) => m.id)));
    }
  }, [media, selectedIds.size]);

  const handleCancelSelection = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const handleDeleteSelected = useCallback(() => {
    const count = selectedIds.size;
    Alert.alert(
      'Delete Files',
      `Are you sure you want to delete ${count} file${count > 1 ? 's' : ''}? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setIsDeleting(true);
            try {
              const idsToDelete = Array.from(selectedIds);
              // Sequential deletion
              for (const id of idsToDelete) {
                await deleteMedia(id);
              }
              setSelectedIds(new Set());
              setIsSelectionMode(false);
            } catch (error) {
              Alert.alert('Error', 'Failed to delete some files. Please try again.');
              console.error('Delete error:', error);
            } finally {
              setIsDeleting(false);
            }
          },
        },
      ]
    );
  }, [selectedIds, deleteMedia]);

  const handleRefresh = useCallback(async () => {
    await triggerSync();
    await loadFolders();
    await loadMedia(currentFolderId);
  }, [triggerSync, loadMedia, loadFolders, currentFolderId]);

  const renderItem = useCallback(
    ({ item }: { item: LocalMediaItem }) => (
      <MediaThumbnail
        media={item}
        size={ITEM_SIZE}
        onPress={() => handlePress(item)}
        onLongPress={() => handleLongPress(item)}
        isSelectionMode={isSelectionMode}
        isSelected={selectedIds.has(item.id)}
      />
    ),
    [handlePress, handleLongPress, isSelectionMode, selectedIds]
  );

  const keyExtractor = useCallback((item: LocalMediaItem) => item.id.toString(), []);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: ITEM_SIZE,
      offset: ITEM_SIZE * Math.floor(index / COLUMNS) + GAP * (Math.floor(index / COLUMNS) + 1),
      index,
    }),
    []
  );

  if (media.length === 0 && !isLoading) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No media files found</Text>
        <Text style={styles.emptySubtext}>
          Upload images and videos to DiscorDrive to see them here
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      {/* Selection Header */}
      {isSelectionMode && (
        <View style={styles.selectionHeader}>
          <Pressable onPress={handleCancelSelection} style={styles.selectionButton}>
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>

          <Text style={styles.selectionCount}>
            {selectedIds.size} selected
          </Text>

          <View style={styles.selectionActions}>
            <Pressable onPress={handleSelectAll} style={styles.selectionButton}>
              <Ionicons
                name={selectedIds.size === media.length ? 'checkbox' : 'checkbox-outline'}
                size={24}
                color="#fff"
              />
            </Pressable>

            <Pressable
              onPress={handleDeleteSelected}
              style={[styles.selectionButton, styles.deleteButton]}
              disabled={selectedIds.size === 0}
            >
              <Ionicons name="trash" size={22} color="#ff4444" />
            </Pressable>
          </View>
        </View>
      )}

      <FlatList
        data={media}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={isLoading || syncState.status === 'syncing' || isDeleting}
            onRefresh={handleRefresh}
            tintColor="#fff"
          />
        }
        removeClippedSubviews
        maxToRenderPerBatch={30}
        windowSize={11}
        initialNumToRender={30}
        getItemLayout={getItemLayout}
        showsVerticalScrollIndicator={false}
        extraData={[isSelectionMode, selectedIds]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  container: {
    paddingHorizontal: GAP,
    paddingTop: GAP,
  },
  row: {
    gap: GAP,
    marginBottom: GAP,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtext: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
  },
  selectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  selectionButton: {
    padding: 8,
  },
  selectionCount: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  selectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  deleteButton: {
    marginLeft: 8,
  },
});
