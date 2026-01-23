import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { useMedia } from '@/providers/MediaProvider';
import * as db from '@/lib/storage/database';

export default function AlbumScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { loadMedia } = useMedia();
  const [isLoading, setIsLoading] = useState(true);
  const [folderName, setFolderName] = useState('Album');

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const folderId = id === 'root' ? null : parseInt(id, 10);
        await loadMedia(folderId);

        // Get folder name if not root
        if (folderId !== null) {
          const items = await db.getAllMedia(folderId);
          if (items.length > 0 && items[0].folderName) {
            setFolderName(items[0].folderName);
          }
        } else {
          setFolderName('Root');
        }
      } catch (error) {
        console.error('Failed to load album:', error);
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [id, loadMedia]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <GalleryGrid />
    </View>
  );
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
});
