# Gallery App Setup Guide

## ⚠️ IMPORTANT: Development Build Required

**Expo Go does NOT support full media library access!**

You must build a development build to test upload and device sync features.

## Quick Start

### 1. Build the App

```bash
cd /home/ubuntu/Desktop/discordrive_v2/apps/gallery

# Clean and prebuild native code
npx expo prebuild --clean

# Build and run on Android
npx expo run:android

# OR for iOS
npx expo run:ios
```

### 2. Connect Device/Emulator

**Android Physical Device:**
```bash
# Make sure device is connected via USB
adb devices

# If not detected, enable USB debugging on device
```

**Android Emulator:**
```bash
# Start emulator first, then run
npx expo run:android
```

## Common Issues

### Issue 1: "Expo Go can no longer provide full access to media library"

**Solution:** Build a development build (not Expo Go)
```bash
npx expo run:android
```

### Issue 2: "Network request failed"

**Check API URL in `app.json`:**
```json
{
  "extra": {
    "apiBase": "http://146.59.126.32:3000/api"  // ← Make sure this is correct
  }
}
```

**For Android Emulator:**
- Use `http://10.0.2.2:3000/api` for localhost
- Use real IP for external server

**For Physical Device:**
- Use real IP address (not localhost)
- Make sure device is on same network as server

### Issue 3: Permission errors

**After changing permissions:**
```bash
# Rebuild native code
npx expo prebuild --clean

# Uninstall old app from device
adb uninstall com.discordrive.gallery

# Build and install new version
npx expo run:android
```

### Issue 4: "Method deleteAsync is deprecated"

**Fixed!** Now using `expo-file-system/legacy`

If you still see this, reload the app:
```bash
# Press 'r' in terminal
# OR shake device and press "Reload"
```

## Permissions Required

### Android (automatically added):
- `READ_EXTERNAL_STORAGE` - Read files (Android < 13)
- `READ_MEDIA_IMAGES` - Read images (Android 13+)
- `READ_MEDIA_VIDEO` - Read videos (Android 13+)
- `WRITE_EXTERNAL_STORAGE` - Write files
- `USE_BIOMETRIC` - Fingerprint auth
- `USE_FINGERPRINT` - Fingerprint auth

### iOS (automatically added):
- `NSPhotoLibraryUsageDescription` - Access photos
- `NSPhotoLibraryAddUsageDescription` - Save photos
- `NSCameraUsageDescription` - Camera access

## Testing Upload Features

### Test 1: Manual Upload (Pick Files)

1. Launch app and login
2. Tap "+" button in header
3. Select 1-3 photos/videos
4. Enter encryption key if prompted
5. Wait for upload to complete
6. Verify files appear in gallery

### Test 2: Device Sync (Backup All)

1. Go to Settings
2. Tap "Sync from Device"
3. Confirm sync
4. Enter encryption key if prompted
5. Wait for scanning (may take a while)
6. Watch upload progress
7. Verify all media synced

### Test 3: Encryption Key Dialog

1. Logout from app
2. Login again (without key sync enabled)
3. Try to upload
4. Dialog should appear
5. Enter encryption key
6. Upload should proceed

## Development Commands

```bash
# Start Metro bundler
npm start

# Build Android
npx expo run:android

# Build iOS
npx expo run:ios

# Clean build
npx expo prebuild --clean

# Check logs
npx react-native log-android  # Android logs
npx react-native log-ios      # iOS logs

# Type check
npm run typecheck

# Lint
npm run lint
```

## Debugging

### View Console Logs

**In Terminal:**
```bash
# Android
adb logcat *:S ReactNative:V ReactNativeJS:V

# Filtered
adb logcat | grep -i "upload"
```

**In App:**
- Shake device
- Select "Debug JS Remotely"
- Open Chrome DevTools

### Network Debugging

**Check API connection:**
```bash
# From your computer
curl http://146.59.126.32:3000/api/auth/login

# From Android emulator
adb shell
curl http://10.0.2.2:3000/api/auth/login
```

### Clear App Data

```bash
# Android
adb shell pm clear com.discordrive.gallery

# Then relaunch app
```

## Troubleshooting Checklist

- [ ] Built development build (not using Expo Go)
- [ ] Correct API URL in app.json
- [ ] Permissions granted on device
- [ ] Server is running and accessible
- [ ] Device/emulator on same network as server
- [ ] Logged in with valid credentials
- [ ] Encryption key entered (or key sync enabled)

## File Structure

```
apps/gallery/
├── app/                          # Screens
│   ├── index.tsx                # Gallery screen (+ button)
│   ├── settings.tsx             # Settings (Sync from Device)
│   └── _layout.tsx              # Providers setup
├── lib/
│   ├── upload/
│   │   ├── service.ts           # Upload logic
│   │   └── deviceScanner.ts    # Device media scanning
│   └── crypto/
│       └── keys.ts              # Encryption key management
├── components/
│   ├── upload/
│   │   └── UploadProgressSheet.tsx  # Upload UI
│   └── encryption/
│       └── EncryptionKeyDialog.tsx  # Key input dialog
└── providers/
    └── UploadProvider.tsx       # Upload state management
```

## Performance Tips

1. **Large Libraries**: Device sync may take time for 1000+ photos
2. **WiFi Recommended**: Use WiFi for faster uploads
3. **Background**: Keep app in foreground during upload
4. **Battery**: Connect to charger for large syncs

## Known Limitations

1. **Expo Go**: Cannot test full functionality
2. **Android 13+**: Requires granular permissions (images/video separate)
3. **Large Files**: Videos > 1GB may take several minutes
4. **Network**: Upload speed depends on connection
5. **Encryption**: Adds ~10% overhead to file size

## Support

If you encounter issues:

1. Check console logs for errors
2. Verify API server is running
3. Test API endpoint with curl
4. Check device permissions in Settings
5. Try clearing app data and reinstalling

## Next Steps After Setup

1. Enable key sync in web app (optional)
2. Test upload with small files first
3. Verify encryption works (files should be encrypted on server)
4. Test device sync with a few photos
5. Monitor upload progress and speed
