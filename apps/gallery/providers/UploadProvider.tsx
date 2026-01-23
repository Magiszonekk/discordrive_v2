import {
  createContext,
  useContext,
  useState,
  useCallback,
  PropsWithChildren,
} from 'react';
import * as ImagePicker from 'expo-image-picker';
import { UploadService, UploadProgress } from '@/lib/upload/service';
import { DeviceMediaScanner, DeviceMediaItem, ScanProgress } from '@/lib/upload/deviceScanner';
import { EncryptionKeyDialog } from '@/components/encryption/EncryptionKeyDialog';
import { hasEncryptionKey, storeEncryptionKey } from '@/lib/crypto/keys';
import { useMedia } from './MediaProvider';
import { useAuth } from './AuthProvider';
import { useSync } from './SyncProvider';

export interface UploadItem {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  status: 'pending' | 'encrypting' | 'uploading' | 'complete' | 'error' | 'cancelled';
  progress: number;
  currentPart?: number;
  totalParts?: number;
  speedBps?: number;
  message?: string;
  error?: string;
  fileId?: number;
  uri: string;
}

export interface DeviceSyncState {
  status: 'idle' | 'scanning' | 'syncing' | 'complete' | 'error';
  scannedCount: number;
  totalCount: number;
  uploadedCount: number;
  failedCount: number;
  currentFile?: string;
  error?: string;
}

interface UploadContextType {
  uploads: UploadItem[];
  deviceSync: DeviceSyncState;
  pickAndUpload: () => Promise<void>;
  syncFromDevice: (options?: { photosOnly?: boolean; videosOnly?: boolean }) => Promise<void>;
  cancelUpload: (id: string) => void;
  cancelDeviceSync: () => void;
  clearCompleted: () => void;
  removeUpload: (id: string) => void;
  showKeyDialog: boolean;
  setShowKeyDialog: (show: boolean) => void;
}

const UploadContext = createContext<UploadContextType | null>(null);

export function useUpload() {
  const context = useContext(UploadContext);
  if (!context) {
    throw new Error('useUpload must be used within UploadProvider');
  }
  return context;
}

export function UploadProvider({ children }: PropsWithChildren) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [deviceSync, setDeviceSync] = useState<DeviceSyncState>({
    status: 'idle',
    scannedCount: 0,
    totalCount: 0,
    uploadedCount: 0,
    failedCount: 0,
  });
  const [showKeyDialog, setShowKeyDialog] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null);

  const { loadMedia } = useMedia();
  const { token } = useAuth();
  const { triggerSync } = useSync();
  const [uploadServices] = useState<Map<string, UploadService>>(new Map());
  const [deviceScanner] = useState<DeviceMediaScanner>(new DeviceMediaScanner());

  const updateUpload = useCallback((id: string, updates: Partial<UploadItem>) => {
    setUploads((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...updates } : u))
    );
  }, []);

  const addUpload = useCallback((upload: UploadItem) => {
    setUploads((prev) => [...prev, upload]);
  }, []);

  const removeUpload = useCallback((id: string) => {
    uploadServices.get(id)?.abort();
    uploadServices.delete(id);
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, [uploadServices]);

  const clearCompleted = useCallback(() => {
    setUploads((prev) =>
      prev.filter(
        (u) => u.status !== 'complete' && u.status !== 'error' && u.status !== 'cancelled'
      )
    );
  }, []);

  // Check if encryption key exists, if not show dialog
  const ensureEncryptionKey = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    const keyExists = await hasEncryptionKey();
    if (!keyExists) {
      setPendingAction(() => action);
      setShowKeyDialog(true);
      return false;
    }
    return true;
  }, []);

  // Handle encryption key submission
  const handleKeySubmit = useCallback(async (key: string) => {
    await storeEncryptionKey(key);
    setShowKeyDialog(false);

    // Execute pending action if any
    if (pendingAction) {
      await pendingAction();
      setPendingAction(null);
    }
  }, [pendingAction]);

  // Handle key dialog cancel
  const handleKeyCancel = useCallback(() => {
    setShowKeyDialog(false);
    setPendingAction(null);
  }, []);

  const getMimeType = (uri: string, mediaType: 'photo' | 'video'): string => {
    const ext = uri.split('.').pop()?.toLowerCase();

    if (mediaType === 'video') {
      switch (ext) {
        case 'mp4': return 'video/mp4';
        case 'mov': return 'video/quicktime';
        case 'avi': return 'video/x-msvideo';
        case 'mkv': return 'video/x-matroska';
        case 'webm': return 'video/webm';
        default: return 'video/mp4';
      }
    } else {
      switch (ext) {
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'png': return 'image/png';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'heic': return 'image/heic';
        default: return 'image/jpeg';
      }
    }
  };

  const uploadSingleFile = async (
    uri: string,
    fileName: string,
    fileSize: number,
    mimeType: string,
    folderId: number | null = null
  ): Promise<number> => {
    if (!token) {
      throw new Error('Not authenticated');
    }

    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const service = new UploadService(token);
    uploadServices.set(uploadId, service);

    const newUpload: UploadItem = {
      id: uploadId,
      fileName,
      fileSize,
      mimeType,
      status: 'pending',
      progress: 0,
      message: 'Preparing upload...',
      uri,
    };

    addUpload(newUpload);

    try {
      const fileId = await service.uploadFile(
        uri,
        fileName,
        fileSize,
        mimeType,
        folderId,
        (progress: UploadProgress) => {
          updateUpload(uploadId, {
            status: progress.type === 'complete' ? 'complete' :
                    progress.type === 'error' ? 'error' :
                    progress.type === 'uploading' ? 'uploading' :
                    progress.type === 'encrypting' ? 'encrypting' : 'pending',
            progress: progress.progress,
            currentPart: progress.currentPart,
            totalParts: progress.totalParts,
            speedBps: progress.speedBps,
            message: progress.message,
            error: progress.error,
            fileId: progress.fileId,
          });
        }
      );

      uploadServices.delete(uploadId);
      // Trigger sync to fetch the newly uploaded file from server
      await triggerSync();
      return fileId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      updateUpload(uploadId, {
        status: 'error',
        error: errorMessage,
        message: errorMessage,
      });
      uploadServices.delete(uploadId);
      throw error;
    }
  };

  const pickAndUpload = useCallback(async () => {
    // Check encryption key first
    const hasKey = await ensureEncryptionKey(async () => {
      await pickAndUpload();
    });

    if (!hasKey) {
      return; // Will show key dialog
    }

    try {
      // Request permissions
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Media library permission not granted');
      }

      // Pick images/videos
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        quality: 1,
      });

      if (result.canceled) {
        return;
      }

      // Upload each selected file
      for (const asset of result.assets) {
        const fileName = asset.fileName || `media_${Date.now()}`;
        const fileSize = asset.fileSize || 0;
        const mimeType = asset.mimeType ||
          (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');

        uploadSingleFile(asset.uri, fileName, fileSize, mimeType).catch((error) => {
          console.error('Upload failed:', error);
        });
      }
    } catch (error) {
      console.error('Pick and upload failed:', error);
      throw error;
    }
  }, [uploadSingleFile, ensureEncryptionKey]);

  const syncFromDevice = useCallback(
    async (options?: { photosOnly?: boolean; videosOnly?: boolean }) => {
      // Check encryption key first
      const hasKey = await ensureEncryptionKey(async () => {
        await syncFromDevice(options);
      });

      if (!hasKey) {
        return; // Will show key dialog
      }

      try {
        // Request permissions
        const hasPermission = await deviceScanner.hasPermissions();
        if (!hasPermission) {
          const granted = await deviceScanner.requestPermissions();
          if (!granted) {
            throw new Error('Media library permission not granted');
          }
        }

        setDeviceSync({
          status: 'scanning',
          scannedCount: 0,
          totalCount: 0,
          uploadedCount: 0,
          failedCount: 0,
        });

        // Scan device media
        let deviceMedia: DeviceMediaItem[] = [];

        if (options?.photosOnly) {
          deviceMedia = await deviceScanner.scanPhotos((progress: ScanProgress) => {
            setDeviceSync((prev) => ({
              ...prev,
              scannedCount: progress.scanned,
              totalCount: progress.total,
            }));
          });
        } else if (options?.videosOnly) {
          deviceMedia = await deviceScanner.scanVideos((progress: ScanProgress) => {
            setDeviceSync((prev) => ({
              ...prev,
              scannedCount: progress.scanned,
              totalCount: progress.total,
            }));
          });
        } else {
          deviceMedia = await deviceScanner.scanAllMedia((progress: ScanProgress) => {
            setDeviceSync((prev) => ({
              ...prev,
              scannedCount: progress.scanned,
              totalCount: progress.total,
            }));
          });
        }

        // Start syncing
        setDeviceSync((prev) => ({
          ...prev,
          status: 'syncing',
          totalCount: deviceMedia.length,
        }));

        let uploadedCount = 0;
        let failedCount = 0;

        // Upload each media file
        for (const media of deviceMedia) {
          try {
            setDeviceSync((prev) => ({
              ...prev,
              currentFile: media.filename,
            }));

            const mimeType = getMimeType(media.uri, media.mediaType);
            const fileSize = media.fileSize || 0;

            // Skip files with unknown or zero size
            if (!fileSize || fileSize <= 0) {
              console.warn(`Skipping ${media.filename}: file size unknown or zero`);
              failedCount++;
              setDeviceSync((prev) => ({
                ...prev,
                failedCount,
              }));
              continue;
            }

            await uploadSingleFile(
              media.uri,
              media.filename,
              fileSize,
              mimeType
            );

            uploadedCount++;
            setDeviceSync((prev) => ({
              ...prev,
              uploadedCount,
            }));
          } catch (error) {
            console.error(`Failed to upload ${media.filename}:`, error);
            failedCount++;
            setDeviceSync((prev) => ({
              ...prev,
              failedCount,
            }));
          }
        }

        setDeviceSync((prev) => ({
          ...prev,
          status: 'complete',
          currentFile: undefined,
        }));

        await loadMedia();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Device sync failed';
        setDeviceSync((prev) => ({
          ...prev,
          status: 'error',
          error: errorMessage,
        }));
        throw error;
      }
    },
    [deviceScanner, uploadSingleFile, loadMedia, ensureEncryptionKey]
  );

  const cancelUpload = useCallback(
    (id: string) => {
      const service = uploadServices.get(id);
      if (service) {
        service.abort();
        uploadServices.delete(id);
      }
      updateUpload(id, {
        status: 'cancelled',
        message: 'Upload cancelled',
      });
    },
    [uploadServices, updateUpload]
  );

  const cancelDeviceSync = useCallback(() => {
    deviceScanner.abort();
    setDeviceSync((prev) => ({
      ...prev,
      status: 'idle',
    }));
  }, [deviceScanner]);

  return (
    <UploadContext.Provider
      value={{
        uploads,
        deviceSync,
        pickAndUpload,
        syncFromDevice,
        cancelUpload,
        cancelDeviceSync,
        clearCompleted,
        removeUpload,
        showKeyDialog,
        setShowKeyDialog,
      }}
    >
      {children}
      <EncryptionKeyDialog
        visible={showKeyDialog}
        onCancel={handleKeyCancel}
        onSubmit={handleKeySubmit}
      />
    </UploadContext.Provider>
  );
}
