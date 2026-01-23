// Polyfill for Web Crypto API (must be first import)
import { install } from 'react-native-quick-crypto';
install();

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '@/providers/AuthProvider';
import { MediaProvider } from '@/providers/MediaProvider';
import { SyncProvider } from '@/providers/SyncProvider';
import { UploadProvider } from '@/providers/UploadProvider';
import { FolderProvider } from '@/providers/FolderProvider';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <MediaProvider>
            <FolderProvider>
              <SyncProvider>
                <UploadProvider>
                <StatusBar style="light" />
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: '#000' },
                  headerTintColor: '#fff',
                  contentStyle: { backgroundColor: '#000' },
                }}
              >
                <Stack.Screen
                  name="index"
                  options={{
                    title: 'Gallery',
                    headerLargeTitle: true,
                  }}
                />
                <Stack.Screen
                  name="login"
                  options={{
                    title: 'Login',
                    presentation: 'modal',
                    headerShown: false,
                  }}
                />
                <Stack.Screen
                  name="photo/[id]"
                  options={{
                    title: '',
                    headerTransparent: true,
                    presentation: 'fullScreenModal',
                  }}
                />
                <Stack.Screen
                  name="album/[id]"
                  options={{
                    title: 'Album',
                  }}
                />
                <Stack.Screen
                  name="settings"
                  options={{
                    title: 'Settings',
                    presentation: 'modal',
                  }}
                />
              </Stack>
                </UploadProvider>
              </SyncProvider>
            </FolderProvider>
          </MediaProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
