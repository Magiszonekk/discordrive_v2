import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUpload } from '@/providers/UploadProvider';

export function UploadProgressSheet() {
  const { uploads, cancelUpload, removeUpload, clearCompleted } = useUpload();

  if (uploads.length === 0) {
    return null;
  }

  const activeUploads = uploads.filter(
    (u) => u.status === 'uploading' || u.status === 'encrypting' || u.status === 'pending'
  );
  const completedUploads = uploads.filter((u) => u.status === 'complete');
  const failedUploads = uploads.filter((u) => u.status === 'error' || u.status === 'cancelled');

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Uploads</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{uploads.length}</Text>
          </View>
        </View>
        {completedUploads.length > 0 && (
          <Pressable onPress={clearCompleted}>
            <Text style={styles.clearButton}>Clear</Text>
          </Pressable>
        )}
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {activeUploads.map((upload) => (
          <View key={upload.id} style={styles.uploadItem}>
            <View style={styles.uploadInfo}>
              <View style={styles.uploadIcon}>
                <Ionicons
                  name={upload.mimeType.startsWith('video/') ? 'videocam' : 'image'}
                  size={20}
                  color="#fff"
                />
              </View>
              <View style={styles.uploadDetails}>
                <Text style={styles.uploadName} numberOfLines={1}>
                  {upload.fileName}
                </Text>
                <Text style={styles.uploadStatus}>
                  {upload.message || `${upload.progress}%`}
                </Text>
                {upload.speedBps && upload.speedBps > 0 && (
                  <Text style={styles.uploadSpeed}>
                    {formatSpeed(upload.speedBps)}
                  </Text>
                )}
              </View>
            </View>

            <View style={styles.uploadActions}>
              {(upload.status === 'uploading' ||
                upload.status === 'encrypting' ||
                upload.status === 'pending') && (
                <Pressable
                  style={styles.actionButton}
                  onPress={() => cancelUpload(upload.id)}
                >
                  <Ionicons name="close-circle" size={24} color="#ff4444" />
                </Pressable>
              )}
            </View>

            {/* Progress bar */}
            {(upload.status === 'uploading' || upload.status === 'encrypting') && (
              <View style={styles.progressBarContainer}>
                <View
                  style={[styles.progressBar, { width: `${upload.progress}%` }]}
                />
              </View>
            )}
          </View>
        ))}

        {completedUploads.map((upload) => (
          <View key={upload.id} style={styles.uploadItem}>
            <View style={styles.uploadInfo}>
              <View style={[styles.uploadIcon, { backgroundColor: '#4CAF50' }]}>
                <Ionicons name="checkmark" size={20} color="#fff" />
              </View>
              <View style={styles.uploadDetails}>
                <Text style={styles.uploadName} numberOfLines={1}>
                  {upload.fileName}
                </Text>
                <Text style={[styles.uploadStatus, { color: '#4CAF50' }]}>
                  Upload complete
                </Text>
              </View>
            </View>

            <Pressable
              style={styles.actionButton}
              onPress={() => removeUpload(upload.id)}
            >
              <Ionicons name="close" size={20} color="#666" />
            </Pressable>
          </View>
        ))}

        {failedUploads.map((upload) => (
          <View key={upload.id} style={styles.uploadItem}>
            <View style={styles.uploadInfo}>
              <View style={[styles.uploadIcon, { backgroundColor: '#ff4444' }]}>
                <Ionicons name="alert" size={20} color="#fff" />
              </View>
              <View style={styles.uploadDetails}>
                <Text style={styles.uploadName} numberOfLines={1}>
                  {upload.fileName}
                </Text>
                <Text style={[styles.uploadStatus, { color: '#ff4444' }]}>
                  {upload.error || 'Upload failed'}
                </Text>
              </View>
            </View>

            <Pressable
              style={styles.actionButton}
              onPress={() => removeUpload(upload.id)}
            >
              <Ionicons name="close" size={20} color="#666" />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function formatSpeed(bytesPerSecond: number): string {
  const mbps = bytesPerSecond / (1024 * 1024);
  return mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${(mbps * 1024).toFixed(0)} KB/s`;
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: 400,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  badge: {
    backgroundColor: '#333',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  clearButton: {
    color: '#2196F3',
    fontSize: 14,
    fontWeight: '500',
  },
  list: {
    maxHeight: 320,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  uploadItem: {
    backgroundColor: '#222',
    borderRadius: 12,
    padding: 12,
  },
  uploadInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  uploadIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadDetails: {
    flex: 1,
    gap: 2,
  },
  uploadName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  uploadStatus: {
    color: '#888',
    fontSize: 12,
  },
  uploadSpeed: {
    color: '#2196F3',
    fontSize: 11,
    fontWeight: '500',
  },
  uploadActions: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  actionButton: {
    padding: 4,
  },
  progressBarContainer: {
    height: 3,
    backgroundColor: '#333',
    borderRadius: 2,
    marginTop: 8,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#2196F3',
    borderRadius: 2,
  },
});
