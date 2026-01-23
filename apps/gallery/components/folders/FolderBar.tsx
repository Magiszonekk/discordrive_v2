import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
  Modal,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFolders } from '@/providers/FolderProvider';
import type { GalleryFolder } from '@discordrive/shared/types';

export function FolderBar() {
  const {
    folders,
    currentFolderId,
    currentFolder,
    navigateToFolder,
    createFolder,
    deleteFolder,
    loadFolders,
    rootMediaCount,
  } = useFolders();

  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) {
      Alert.alert('Error', 'Please enter a folder name');
      return;
    }

    try {
      await createFolder(name);
      setCreateModalVisible(false);
      setNewFolderName('');
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to create folder');
    }
  }, [newFolderName, createFolder]);

  const handleFolderLongPress = useCallback((folder: GalleryFolder) => {
    Alert.alert(
      folder.name,
      `${folder.mediaCount} items`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Delete Folder',
              `Delete "${folder.name}" and all its contents?`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => deleteFolder(folder.id),
                },
              ]
            );
          },
        },
      ]
    );
  }, [deleteFolder]);

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Back button when in a folder */}
        {currentFolderId !== null && (
          <Pressable
            style={[styles.folderChip, styles.backChip]}
            onPress={() => navigateToFolder(null)}
          >
            <Ionicons name="arrow-back" size={16} color="#fff" />
            <Text style={styles.folderChipText}>All</Text>
          </Pressable>
        )}

        {/* All Files chip (only when not in a folder) */}
        {currentFolderId === null && (
          <Pressable
            style={[styles.folderChip, styles.activeChip]}
            onPress={() => navigateToFolder(null)}
          >
            <Ionicons name="images-outline" size={16} color="#fff" />
            <Text style={styles.folderChipText}>All ({rootMediaCount})</Text>
          </Pressable>
        )}

        {/* Folder chips */}
        {folders.map((folder) => (
          <Pressable
            key={folder.id}
            style={[
              styles.folderChip,
              currentFolderId === folder.id && styles.activeChip,
            ]}
            onPress={() => navigateToFolder(folder.id)}
            onLongPress={() => handleFolderLongPress(folder)}
            delayLongPress={500}
          >
            <Ionicons
              name={currentFolderId === folder.id ? 'folder' : 'folder-outline'}
              size={16}
              color="#fff"
            />
            <Text style={styles.folderChipText}>
              {folder.name} ({folder.mediaCount})
            </Text>
          </Pressable>
        ))}

        {/* Create folder button */}
        <Pressable
          style={[styles.folderChip, styles.createChip]}
          onPress={() => setCreateModalVisible(true)}
        >
          <Ionicons name="add" size={18} color="#2196F3" />
        </Pressable>
      </ScrollView>

      {/* Current folder header */}
      {currentFolder && (
        <View style={styles.currentFolderHeader}>
          <Ionicons name="folder" size={18} color="#2196F3" />
          <Text style={styles.currentFolderName}>{currentFolder.name}</Text>
        </View>
      )}

      {/* Create Folder Modal */}
      <Modal
        visible={createModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCreateModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Create Folder</Text>
            <TextInput
              style={styles.modalInput}
              value={newFolderName}
              onChangeText={setNewFolderName}
              placeholder="Folder name..."
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <View style={styles.modalButtons}>
              <Pressable
                style={[styles.modalButton, styles.modalButtonCancel]}
                onPress={() => {
                  setCreateModalVisible(false);
                  setNewFolderName('');
                }}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={handleCreateFolder}
              >
                <Text style={[styles.modalButtonText, { color: '#fff' }]}>Create</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#000',
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  folderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
  },
  backChip: {
    backgroundColor: '#333',
  },
  activeChip: {
    backgroundColor: '#2196F3',
  },
  createChip: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#2196F3',
    borderStyle: 'dashed',
    paddingHorizontal: 10,
  },
  folderChipText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  currentFolderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  currentFolderName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: '#0a0a0a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 16,
    marginBottom: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalButtonCancel: {
    backgroundColor: '#333',
  },
  modalButtonConfirm: {
    backgroundColor: '#2196F3',
  },
  modalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
