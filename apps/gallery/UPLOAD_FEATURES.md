# Gallery Upload Features

## Overview

The gallery app now supports two methods of uploading photos and videos:

1. **Manual Upload** - Select specific files from device gallery
2. **Device Sync** - Automatically backup all photos and videos from device

## Features

### 1. Manual Upload (Pick and Upload)

- **Location**: Main gallery screen, "+" button in header
- **Functionality**:
  - Opens native image/video picker
  - Supports multiple file selection
  - Uploads with client-side encryption (AES-256-GCM)
  - Shows upload progress for each file
  - Automatic sync after completion

**Usage**:
```typescript
import { useUpload } from '@/providers/UploadProvider';

const { pickAndUpload } = useUpload();

// Trigger file picker and upload
await pickAndUpload();
```

### 2. Device Sync (Full Backup)

- **Location**: Settings screen, "Sync from Device" button
- **Functionality**:
  - Scans all photos and videos on device
  - Shows scan progress (X/Y files scanned)
  - Uploads each media file with encryption
  - Shows upload progress (X/Y files uploaded)
  - Tracks failed uploads
  - Can be cancelled mid-sync

**Usage**:
```typescript
import { useUpload } from '@/providers/UploadProvider';

const { syncFromDevice, deviceSync } = useUpload();

// Sync all media
await syncFromDevice();

// Sync only photos
await syncFromDevice({ photosOnly: true });

// Sync only videos
await syncFromDevice({ videosOnly: true });

// Check sync status
console.log(deviceSync.status); // 'idle' | 'scanning' | 'syncing' | 'complete' | 'error'
console.log(deviceSync.uploadedCount); // Number of files uploaded
console.log(deviceSync.failedCount); // Number of failed uploads
```

## Architecture

### Components

#### 1. UploadService (`lib/upload/service.ts`)
- Handles individual file uploads
- Client-side encryption using AES-256-GCM
- Chunk-based upload (7.5MB chunks)
- Progress callbacks
- Cancellable uploads

**Key Methods**:
- `uploadFile(uri, fileName, fileSize, mimeType, folderId, onProgress)` - Upload a single file

#### 2. DeviceMediaScanner (`lib/upload/deviceScanner.ts`)
- Scans device media library
- Pagination support (100 items per page)
- Filters by media type (photo/video)
- Retrieves file metadata (size, dimensions, timestamps)

**Key Methods**:
- `scanAllMedia(onProgress)` - Scan all photos and videos
- `scanPhotos(onProgress)` - Scan only photos
- `scanVideos(onProgress)` - Scan only videos
- `requestPermissions()` - Request media library access
- `hasPermissions()` - Check permission status
- `abort()` - Cancel current scan

#### 3. UploadProvider (`providers/UploadProvider.tsx`)
- React context for upload state management
- Manages multiple concurrent uploads
- Device sync orchestration
- Upload queue management

**State**:
```typescript
interface UploadItem {
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

interface DeviceSyncState {
  status: 'idle' | 'scanning' | 'syncing' | 'complete' | 'error';
  scannedCount: number;
  totalCount: number;
  uploadedCount: number;
  failedCount: number;
  currentFile?: string;
  error?: string;
}
```

#### 4. UploadProgressSheet (`components/upload/UploadProgressSheet.tsx`)
- Bottom sheet UI component
- Shows real-time upload progress
- Displays upload speed
- Cancel/remove uploads
- Clear completed uploads

### UI Components

1. **Gallery Header** (`app/index.tsx`)
   - "+" button for manual upload
   - Displays upload progress sheet when active

2. **Settings Screen** (`app/settings.tsx`)
   - "Sync from Device" button
   - Shows sync progress inline
   - Displays last sync stats

3. **Upload Progress Sheet** (`components/upload/UploadProgressSheet.tsx`)
   - Active uploads with progress bars
   - Upload speed indicators
   - Cancel buttons
   - Completed/failed upload list

## Permissions

The app requires the following permissions:

### iOS (info.plist)
```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>We need access to your photos to upload them to the cloud</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>We need access to save photos to your library</string>
```

### Android (AndroidManifest.xml)
```xml
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
```

## Encryption

All uploads use client-side encryption with:
- **Algorithm**: AES-256-GCM
- **Key Derivation**: PBKDF2-SHA256 (simplified for React Native)
- **Chunk Size**: 7.5MB (max 8MB encrypted)
- **Per-Chunk**: Unique IV and auth tag

### Encryption Flow

1. Generate random salt (32 bytes)
2. Derive encryption key from user password + salt
3. Split file into chunks (7.5MB each)
4. For each chunk:
   - Generate random IV (12 bytes)
   - Encrypt with AES-256-GCM
   - Store IV and auth tag with chunk metadata
5. Upload encrypted chunks to server
6. Store encryption header with file metadata

## API Integration

### Endpoints Used

1. **POST /api/files** - Initialize upload session
   - Body: `{ originalName, size, mimeType, totalParts, folderId, encryptionHeader, mediaWidth, mediaHeight }`
   - Returns: `{ fileId, chunkSize, batchSize, botCount }`

2. **POST /api/files/:id/chunks** - Upload chunk batch
   - FormData with metadata + chunk files
   - Multiple chunks per request (batch upload)

3. **POST /api/files/:id/finish** - Finalize upload
   - Marks upload as complete

## Performance

### Optimization Features

- **Concurrent Uploads**: Upload multiple files in parallel
- **Chunk Batching**: Multiple chunks per HTTP request
- **Progress Tracking**: Real-time progress updates
- **Memory Management**: Chunks released after upload
- **Speed Monitoring**: Upload speed calculation (MB/s)

### Typical Performance

- **Small Files** (< 10MB): 1-3 seconds
- **Medium Files** (10-100MB): 5-30 seconds
- **Large Files** (> 100MB): 30+ seconds
- **Upload Speed**: Depends on network (typically 5-20 MB/s on WiFi)

## Error Handling

### Common Errors

1. **No Encryption Key** - User must be logged in with encryption key
2. **Permission Denied** - Media library access not granted
3. **Network Error** - Connection issues during upload
4. **File Too Large** - Exceeds max file size (check backend config)
5. **Authentication Error** - Invalid or expired auth token

### Error Recovery

- Failed uploads can be retried
- Device sync continues after individual file failures
- Partial uploads are cleaned up on cancel
- Upload state persisted in provider

## Testing

### Manual Testing

1. **Pick and Upload**:
   - Tap "+" button
   - Select 1-5 files
   - Verify upload progress
   - Check files appear in gallery after sync

2. **Device Sync**:
   - Go to Settings
   - Tap "Sync from Device"
   - Verify scan progress
   - Verify upload progress
   - Check all files uploaded

3. **Cancel Upload**:
   - Start upload
   - Tap cancel button
   - Verify upload stops
   - Verify cleanup

### Edge Cases

- Empty gallery (no files to sync)
- Permission denied
- Network disconnection mid-upload
- Large file (> 1GB)
- Many small files (> 1000)
- Mixed photo and video

## Future Improvements

1. **Incremental Sync** - Only upload new/modified files
2. **Duplicate Detection** - Skip files already on server
3. **Compression** - Compress images before upload
4. **Background Upload** - Continue uploads in background
5. **Selective Sync** - Choose specific albums/folders
6. **Upload Queue** - Persistent queue with retry logic
7. **Bandwidth Control** - Limit upload speed
8. **WiFi-Only Mode** - Prevent uploads on cellular
9. **Auto-Sync** - Automatic background sync on schedule
10. **Video Transcoding** - Reduce video size before upload

## Dependencies

- `expo-image-picker` (v17.0.10) - Image/video picker
- `expo-media-library` (v18.2.1) - Media library access
- `expo-file-system` (v19.0.21) - File system operations
- `expo-crypto` (v15.0.8) - Cryptographic operations
- `expo-secure-store` (v15.0.8) - Secure key storage

## Migration Notes

No migration needed - this is a new feature. Existing gallery functionality remains unchanged.

## Support

For issues or questions:
1. Check console logs for detailed error messages
2. Verify permissions are granted
3. Check network connectivity
4. Ensure user is logged in with encryption key
5. Check backend logs for server-side errors
