import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
  Switch,
  TextInput,
  Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { getRandomBytes } from 'expo-crypto';
import { useAuth } from '@/providers/AuthProvider';
import { useSync } from '@/providers/SyncProvider';
import { useMedia } from '@/providers/MediaProvider';
import { useUpload } from '@/providers/UploadProvider';
import { clearAllThumbnails, getThumbnailStorageSize } from '@/lib/crypto/thumbnail';
import {
  hasEncryptionKey,
  getEncryptionKey,
  storeEncryptionKey,
  clearEncryptionKey,
  encryptKeyWithPassword,
} from '@/lib/crypto/keys';
import { bytesToBase64 } from '@/lib/crypto/utils';
import { galleryApi } from '@/lib/api/client';
import * as db from '@/lib/storage/database';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { syncState, fullSync } = useSync();
  const { clearAllMedia } = useMedia();
  const { syncFromDevice, deviceSync } = useUpload();
  const [thumbnailSize, setThumbnailSize] = useState(0);
  const [mediaCount, setMediaCount] = useState(0);

  // Encryption state
  const [hasKey, setHasKey] = useState(false);
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(false);
  const [keyModalVisible, setKeyModalVisible] = useState(false);
  const [importKeyValue, setImportKeyValue] = useState('');
  const [passwordModalVisible, setPasswordModalVisible] = useState(false);
  const [passwordValue, setPasswordValue] = useState('');

  useEffect(() => {
    loadStats();
    loadEncryptionState();
  }, []);

  async function loadStats() {
    const size = await getThumbnailStorageSize();
    const count = await db.getMediaCount();
    setThumbnailSize(size);
    setMediaCount(count);
  }

  async function loadEncryptionState() {
    const keyExists = await hasEncryptionKey();
    setHasKey(keyExists);

    // Check cloud sync status
    try {
      const response = await galleryApi.getEncryptionKey();
      setCloudSyncEnabled(response.enabled);
    } catch {
      setCloudSyncEnabled(false);
    }
  }

  const handleClearThumbnails = useCallback(() => {
    Alert.alert(
      'Clear Thumbnails',
      'This will delete all locally cached thumbnails. They will be regenerated when you view the gallery.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearAllThumbnails();
            setThumbnailSize(0);
          },
        },
      ]
    );
  }, []);

  const handleFullSync = useCallback(() => {
    Alert.alert(
      'Full Sync',
      'This will resync all media from the server. This may take a while.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sync',
          onPress: async () => {
            await fullSync();
            await loadStats();
          },
        },
      ]
    );
  }, [fullSync]);

  const handleDeviceSync = useCallback(() => {
    Alert.alert(
      'Sync from Device',
      'This will upload all photos and videos from your device to the cloud. This may take a while.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sync All',
          onPress: async () => {
            try {
              await syncFromDevice();
              await loadStats();
            } catch (error) {
              Alert.alert('Error', error instanceof Error ? error.message : 'Failed to sync');
            }
          },
        },
      ]
    );
  }, [syncFromDevice]);

  const handleClearAll = useCallback(() => {
    Alert.alert(
      'Clear All Data',
      'This will delete all locally cached media and thumbnails. You will need to sync again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            await clearAllMedia();
            await clearAllThumbnails();
            setMediaCount(0);
            setThumbnailSize(0);
          },
        },
      ]
    );
  }, [clearAllMedia]);

  const handleLogout = useCallback(() => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout? All local data will be cleared.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            await clearAllMedia();
            await clearAllThumbnails();
            await logout();
            router.replace('/login');
          },
        },
      ]
    );
  }, [logout, clearAllMedia, router]);

  // Encryption handlers
  const handleGenerateKey = useCallback(() => {
    Alert.alert(
      'Generate New Key',
      hasKey
        ? 'This will replace your existing encryption key. Make sure to backup your current key first!'
        : 'This will generate a new encryption key for your files.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Generate',
          onPress: async () => {
            try {
              const keyBytes = getRandomBytes(32);
              const newKey = bytesToBase64(keyBytes);
              await storeEncryptionKey(newKey);
              setHasKey(true);
              Alert.alert('Success', 'New encryption key generated and saved locally.');
            } catch (error) {
              Alert.alert('Error', error instanceof Error ? error.message : 'Failed to generate key');
            }
          },
        },
      ]
    );
  }, [hasKey]);

  const handleCopyKey = useCallback(async () => {
    const key = await getEncryptionKey();
    if (key) {
      await Clipboard.setStringAsync(key);
      Alert.alert('Copied', 'Encryption key copied to clipboard. Keep it safe!');
    }
  }, []);

  const handleImportKey = useCallback(() => {
    setImportKeyValue('');
    setKeyModalVisible(true);
  }, []);

  const confirmImportKey = useCallback(async () => {
    const trimmedKey = importKeyValue.trim();
    if (!trimmedKey) {
      Alert.alert('Error', 'Please enter a valid key');
      return;
    }

    try {
      await storeEncryptionKey(trimmedKey);
      setHasKey(true);
      setKeyModalVisible(false);
      setImportKeyValue('');
      Alert.alert('Success', 'Encryption key imported successfully.');
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to import key');
    }
  }, [importKeyValue]);

  const handleCloudSyncToggle = useCallback(async (enabled: boolean) => {
    if (enabled) {
      // Enable cloud sync - need to show password modal
      const key = await getEncryptionKey();
      if (!key) {
        Alert.alert('Error', 'No encryption key found. Generate or import one first.');
        return;
      }
      setPasswordValue('');
      setPasswordModalVisible(true);
    } else {
      // Disable cloud sync
      Alert.alert(
        'Disable Cloud Sync',
        'This will remove your encryption key from the cloud. Make sure you have a local backup!',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disable',
            style: 'destructive',
            onPress: async () => {
              try {
                await galleryApi.deleteEncryptionKey();
                setCloudSyncEnabled(false);
              } catch (error) {
                Alert.alert('Error', error instanceof Error ? error.message : 'Failed to disable sync');
              }
            },
          },
        ]
      );
    }
  }, []);

  const confirmCloudSync = useCallback(async () => {
    if (!passwordValue.trim()) {
      Alert.alert('Error', 'Please enter your password');
      return;
    }

    try {
      const key = await getEncryptionKey();
      if (!key) {
        Alert.alert('Error', 'Encryption key not found');
        return;
      }

      const salt = getRandomBytes(16);
      const { encryptedKey, salt: saltBase64 } = await encryptKeyWithPassword(key, passwordValue, salt);
      await galleryApi.saveEncryptionKey(encryptedKey, saltBase64, true);
      setCloudSyncEnabled(true);
      setPasswordModalVisible(false);
      setPasswordValue('');
      Alert.alert('Success', 'Encryption key synced to cloud.');
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to sync key');
    }
  }, [passwordValue]);

  const handleClearKey = useCallback(() => {
    Alert.alert(
      'Clear Encryption Key',
      'This will remove your encryption key from this device. You will not be able to decrypt your files without it!',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearEncryptionKey();
            setHasKey(false);
          },
        },
      ]
    );
  }, []);

  return (
    <ScrollView style={styles.container}>
      {/* Account Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Ionicons name="person-outline" size={20} color="#888" />
              <View>
                <Text style={styles.rowLabel}>{user?.username || 'Unknown'}</Text>
                <Text style={styles.rowSubtext}>{user?.email || ''}</Text>
              </View>
            </View>
          </View>
        </View>
      </View>

      {/* Encryption Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Encryption</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Ionicons
                name={hasKey ? 'key' : 'key-outline'}
                size={20}
                color={hasKey ? '#4CAF50' : '#888'}
              />
              <View>
                <Text style={styles.rowLabel}>Encryption Key</Text>
                <Text style={styles.rowSubtext}>
                  {hasKey ? 'Configured' : 'Not configured'}
                </Text>
              </View>
            </View>
            <View style={[styles.statusBadge, hasKey && styles.statusBadgeActive]}>
              <Text style={[styles.statusText, hasKey && styles.statusTextActive]}>
                {hasKey ? 'Active' : 'None'}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Ionicons name="cloud-outline" size={20} color="#888" />
              <View>
                <Text style={styles.rowLabel}>Cloud Sync</Text>
                <Text style={styles.rowSubtext}>
                  Sync key across devices
                </Text>
              </View>
            </View>
            <Switch
              value={cloudSyncEnabled}
              onValueChange={handleCloudSyncToggle}
              disabled={!hasKey}
              trackColor={{ false: '#333', true: '#4CAF50' }}
              thumbColor="#fff"
            />
          </View>

          <View style={styles.divider} />

          <Pressable style={styles.row} onPress={handleGenerateKey}>
            <View style={styles.rowContent}>
              <Ionicons name="refresh-outline" size={20} color="#2196F3" />
              <Text style={[styles.rowLabel, { color: '#2196F3' }]}>
                Generate New Key
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </Pressable>

          <View style={styles.divider} />

          <Pressable style={styles.row} onPress={handleImportKey}>
            <View style={styles.rowContent}>
              <Ionicons name="download-outline" size={20} color="#2196F3" />
              <Text style={[styles.rowLabel, { color: '#2196F3' }]}>
                Import Key
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </Pressable>

          {hasKey && (
            <>
              <View style={styles.divider} />
              <Pressable style={styles.row} onPress={handleCopyKey}>
                <View style={styles.rowContent}>
                  <Ionicons name="copy-outline" size={20} color="#888" />
                  <Text style={styles.rowLabel}>Copy Key</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#666" />
              </Pressable>

              <View style={styles.divider} />
              <Pressable style={styles.row} onPress={handleClearKey}>
                <View style={styles.rowContent}>
                  <Ionicons name="trash-outline" size={20} color="#ff4444" />
                  <Text style={[styles.rowLabel, { color: '#ff4444' }]}>
                    Clear Key
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#666" />
              </Pressable>
            </>
          )}
        </View>
      </View>

      {/* Storage Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Storage</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Ionicons name="images-outline" size={20} color="#888" />
              <Text style={styles.rowLabel}>Synced Media</Text>
            </View>
            <Text style={styles.rowValue}>{mediaCount} items</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Ionicons name="folder-outline" size={20} color="#888" />
              <Text style={styles.rowLabel}>Thumbnail Cache</Text>
            </View>
            <Text style={styles.rowValue}>{formatFileSize(thumbnailSize)}</Text>
          </View>

          <View style={styles.divider} />

          <Pressable style={styles.row} onPress={handleClearThumbnails}>
            <View style={styles.rowContent}>
              <Ionicons name="trash-outline" size={20} color="#ff8800" />
              <Text style={[styles.rowLabel, { color: '#ff8800' }]}>
                Clear Thumbnails
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </Pressable>
        </View>
      </View>

      {/* Sync Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sync</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Ionicons name="time-outline" size={20} color="#888" />
              <Text style={styles.rowLabel}>Last Sync</Text>
            </View>
            <Text style={styles.rowValue}>
              {syncState.lastSync
                ? new Date(syncState.lastSync).toLocaleString()
                : 'Never'}
            </Text>
          </View>

          <View style={styles.divider} />

          <Pressable style={styles.row} onPress={handleFullSync}>
            <View style={styles.rowContent}>
              <Ionicons name="refresh-outline" size={20} color="#4CAF50" />
              <Text style={[styles.rowLabel, { color: '#4CAF50' }]}>
                Full Sync from Server
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </Pressable>

          <View style={styles.divider} />

          <Pressable
            style={styles.row}
            onPress={handleDeviceSync}
            disabled={deviceSync.status === 'syncing' || deviceSync.status === 'scanning'}
          >
            <View style={styles.rowContent}>
              <Ionicons
                name="phone-portrait-outline"
                size={20}
                color={deviceSync.status === 'syncing' || deviceSync.status === 'scanning' ? '#666' : '#2196F3'}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowLabel, {
                  color: deviceSync.status === 'syncing' || deviceSync.status === 'scanning' ? '#666' : '#2196F3'
                }]}>
                  Sync from Device
                </Text>
                {(deviceSync.status === 'scanning' || deviceSync.status === 'syncing') && (
                  <Text style={styles.rowSubtext}>
                    {deviceSync.status === 'scanning'
                      ? `Scanning: ${deviceSync.scannedCount}/${deviceSync.totalCount}`
                      : `Uploading: ${deviceSync.uploadedCount}/${deviceSync.totalCount}`}
                  </Text>
                )}
                {deviceSync.status === 'complete' && deviceSync.totalCount > 0 && (
                  <Text style={styles.rowSubtext}>
                    Last sync: {deviceSync.uploadedCount} uploaded, {deviceSync.failedCount} failed
                  </Text>
                )}
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </Pressable>
        </View>
      </View>

      {/* Danger Zone */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Danger Zone</Text>
        <View style={styles.card}>
          <Pressable style={styles.row} onPress={handleClearAll}>
            <View style={styles.rowContent}>
              <Ionicons name="warning-outline" size={20} color="#ff4444" />
              <Text style={[styles.rowLabel, { color: '#ff4444' }]}>
                Clear All Local Data
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </Pressable>

          <View style={styles.divider} />

          <Pressable style={styles.row} onPress={handleLogout}>
            <View style={styles.rowContent}>
              <Ionicons name="log-out-outline" size={20} color="#ff4444" />
              <Text style={[styles.rowLabel, { color: '#ff4444' }]}>Logout</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </Pressable>
        </View>
      </View>

      {/* Version */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>DiscorDrive Gallery v1.0.0</Text>
      </View>

      {/* Import Key Modal */}
      <Modal
        visible={keyModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setKeyModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Import Encryption Key</Text>
            <Text style={styles.modalSubtitle}>
              Paste your encryption key below:
            </Text>
            <TextInput
              style={styles.modalInput}
              value={importKeyValue}
              onChangeText={setImportKeyValue}
              placeholder="Enter encryption key..."
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <View style={styles.modalButtons}>
              <Pressable
                style={[styles.modalButton, styles.modalButtonCancel]}
                onPress={() => setKeyModalVisible(false)}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={confirmImportKey}
              >
                <Text style={[styles.modalButtonText, { color: '#fff' }]}>Import</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Password Modal for Cloud Sync */}
      <Modal
        visible={passwordModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPasswordModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Enable Cloud Sync</Text>
            <Text style={styles.modalSubtitle}>
              Enter your account password to encrypt your key for cloud storage:
            </Text>
            <TextInput
              style={[styles.modalInput, { minHeight: 44 }]}
              value={passwordValue}
              onChangeText={setPasswordValue}
              placeholder="Enter password..."
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <View style={styles.modalButtons}>
              <Pressable
                style={[styles.modalButton, styles.modalButtonCancel]}
                onPress={() => {
                  setPasswordModalVisible(false);
                  setPasswordValue('');
                }}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={confirmCloudSync}
              >
                <Text style={[styles.modalButtonText, { color: '#fff' }]}>Enable</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
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
  section: {
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  sectionTitle: {
    color: '#888',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  rowLabel: {
    color: '#fff',
    fontSize: 16,
  },
  rowSubtext: {
    color: '#666',
    fontSize: 13,
    marginTop: 2,
  },
  rowValue: {
    color: '#666',
    fontSize: 14,
  },
  divider: {
    height: 1,
    backgroundColor: '#333',
    marginLeft: 48,
  },
  footer: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  footerText: {
    color: '#666',
    fontSize: 12,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#333',
  },
  statusBadgeActive: {
    backgroundColor: '#1b3d1b',
  },
  statusText: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
  },
  statusTextActive: {
    color: '#4CAF50',
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
    marginBottom: 8,
  },
  modalSubtitle: {
    color: '#888',
    fontSize: 14,
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: '#0a0a0a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
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
