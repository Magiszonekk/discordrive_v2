import { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/providers/AuthProvider';
import { useSync } from '@/providers/SyncProvider';
import { useUpload } from '@/providers/UploadProvider';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { FolderBar } from '@/components/folders/FolderBar';
import { SyncIndicator } from '@/components/sync/SyncIndicator';
import { UploadProgressSheet } from '@/components/upload/UploadProgressSheet';
import { Ionicons } from '@expo/vector-icons';

export default function GalleryScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { syncState, triggerSync } = useSync();
  const { pickAndUpload } = useUpload();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, authLoading]);

  useEffect(() => {
    if (isAuthenticated) {
      triggerSync();
    }
  }, [isAuthenticated]);

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SyncIndicator />
        <View style={styles.headerButtons}>
          <Pressable
            style={styles.iconButton}
            onPress={() => pickAndUpload()}
          >
            <Ionicons name="add-circle-outline" size={28} color="#fff" />
          </Pressable>
          <Pressable
            style={styles.iconButton}
            onPress={() => router.push('/settings')}
          >
            <Ionicons name="settings-outline" size={24} color="#fff" />
          </Pressable>
        </View>
      </View>

      <FolderBar />

      {syncState.status === 'syncing' && syncState.totalItems === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.syncText}>Syncing media...</Text>
        </View>
      ) : (
        <GalleryGrid />
      )}

      <UploadProgressSheet />
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    padding: 8,
  },
  syncText: {
    color: '#888',
    marginTop: 16,
    fontSize: 14,
  },
});
