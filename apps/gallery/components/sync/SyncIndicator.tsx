import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSync } from '@/providers/SyncProvider';

export function SyncIndicator() {
  const { syncState, isOnline, triggerSync } = useSync();

  const getStatusIcon = () => {
    if (!isOnline) {
      return <Ionicons name="cloud-offline-outline" size={16} color="#ff8800" />;
    }
    if (syncState.status === 'syncing') {
      return <ActivityIndicator size="small" color="#4CAF50" />;
    }
    if (syncState.status === 'error') {
      return <Ionicons name="alert-circle-outline" size={16} color="#ff4444" />;
    }
    return <Ionicons name="checkmark-circle-outline" size={16} color="#4CAF50" />;
  };

  const getStatusText = () => {
    if (!isOnline) {
      return 'Offline';
    }
    if (syncState.status === 'syncing') {
      return `Syncing... ${Math.round(syncState.progress * 100)}%`;
    }
    if (syncState.status === 'error') {
      return 'Sync failed';
    }
    if (syncState.lastSync) {
      return `Synced ${formatRelativeTime(syncState.lastSync)}`;
    }
    return 'Not synced';
  };

  return (
    <Pressable
      style={styles.container}
      onPress={() => {
        if (isOnline && syncState.status !== 'syncing') {
          triggerSync();
        }
      }}
    >
      {getStatusIcon()}
      <Text style={styles.text}>{getStatusText()}</Text>
    </Pressable>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
  },
  text: {
    color: '#888',
    fontSize: 12,
  },
});
