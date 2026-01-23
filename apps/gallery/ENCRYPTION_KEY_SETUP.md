# Encryption Key Setup Guide

## Overview

The gallery app now automatically handles encryption key setup with the following flow:

1. **Automatic Key Retrieval** - On login, if user has key sync enabled, the encryption key is automatically retrieved and stored
2. **Manual Key Entry** - If no key is found when uploading, a dialog prompts for manual entry
3. **Secure Storage** - Keys are stored in device secure storage (Keychain on iOS, Keystore on Android)

## How It Works

### Automatic Key Sync (During Login)

When a user logs in with key sync enabled:

```typescript
// In AuthProvider.tsx
async function login(email: string, password: string) {
  const response = await galleryApi.login(email, password);

  // If server returns encrypted key
  if (response.encryptedKey && response.encryptedKeySalt) {
    try {
      // Decrypt key using user's password
      const decryptedKey = await decryptKeyWithPassword(
        response.encryptedKey,
        response.encryptedKeySalt,
        password
      );
      // Store in secure storage
      await storeEncryptionKey(decryptedKey);
    } catch (error) {
      console.error('Failed to decrypt cloud key:', error);
      // Login still succeeds even if key sync fails
    }
  }
}
```

### Manual Key Entry (During Upload)

When user tries to upload without a stored key:

```typescript
// In UploadProvider.tsx
const pickAndUpload = async () => {
  // Check if key exists
  const hasKey = await ensureEncryptionKey(async () => {
    await pickAndUpload(); // Retry after key is entered
  });

  if (!hasKey) {
    // Shows EncryptionKeyDialog
    return;
  }

  // Proceed with upload
  // ...
};
```

## User Experience

### First Upload (No Key Stored)

1. User taps "+" button or "Sync from Device"
2. Dialog appears: "Encryption Key Required"
3. User enters their encryption key
4. Key is validated and stored securely
5. Upload proceeds automatically

### Subsequent Uploads (Key Stored)

1. User taps "+" button or "Sync from Device"
2. Upload starts immediately (no dialog)
3. Stored key is used for encryption

## Components

### EncryptionKeyDialog Component

**Location**: `components/encryption/EncryptionKeyDialog.tsx`

**Features**:
- Clean, modal UI for key entry
- Password visibility toggle
- Input validation
- Error handling
- Loading state during validation
- Helpful hints for users

**Props**:
```typescript
interface EncryptionKeyDialogProps {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (key: string) => Promise<void>;
}
```

### Key Management Functions

**Location**: `lib/crypto/keys.ts`

**New Function**:
```typescript
export async function ensureEncryptionKey(): Promise<string> {
  const key = await getEncryptionKey();
  if (!key) {
    throw new Error('NO_ENCRYPTION_KEY');
  }
  return key;
}
```

**Existing Functions**:
- `storeEncryptionKey(key)` - Store key in secure storage
- `getEncryptionKey()` - Retrieve stored key
- `clearEncryptionKey()` - Remove stored key (on logout)
- `hasEncryptionKey()` - Check if key exists
- `decryptKeyWithPassword(encryptedKey, salt, password)` - Decrypt cloud-synced key

## Security

### Storage

- **iOS**: Keys stored in iOS Keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` accessibility
- **Android**: Keys stored in Android Keystore with hardware-backed encryption (when available)
- Keys never leave the device except during initial cloud sync setup

### Key Derivation

When decrypting cloud-synced keys:
```typescript
// PBKDF2-SHA256 with 100,000 iterations (simplified for React Native)
const derivedKey = await deriveKey(password, saltBytes, 100000);

// AES-256-GCM decryption
const decrypted = await decryptAesGcm(ciphertext, derivedKey, iv);
```

### Upload Encryption

Files are encrypted with:
- **Algorithm**: AES-256-GCM
- **Unique IV** per chunk (12 bytes)
- **Unique Salt** per file (32 bytes)
- **Auth Tag** per chunk (16 bytes)

## Error Handling

### Common Errors

1. **"NO_ENCRYPTION_KEY"**
   - Thrown by `ensureEncryptionKey()`
   - Caught by `UploadProvider`
   - Shows encryption key dialog

2. **"Invalid encryption key"**
   - Key format validation failed
   - Shows error in dialog
   - User can retry

3. **"Failed to decrypt cloud key"**
   - Cloud key sync failed during login
   - Login still succeeds
   - User can enter key manually later

### Error Recovery

```typescript
try {
  await ensureEncryptionKey();
  // Proceed with upload
} catch (error) {
  if (error.message === 'NO_ENCRYPTION_KEY') {
    // Show dialog
    setShowKeyDialog(true);
  } else {
    // Other errors
    console.error('Encryption error:', error);
  }
}
```

## Configuration

### Enable Key Sync (Backend)

Users must enable key sync in web frontend:
1. Go to Settings
2. Enable "Sync Encryption Key"
3. Enter encryption key
4. Key is encrypted with password and stored on server

### Disable Key Sync

If user doesn't want cloud key sync:
1. They can enter key manually on first upload
2. Key is stored locally in secure storage
3. Works across app sessions
4. Requires re-entry after app reinstall

## Testing

### Test Scenarios

1. **New User with Key Sync**
   - Login → Key auto-retrieved → Upload works immediately

2. **New User without Key Sync**
   - Login → First upload → Dialog shown → Enter key → Upload works

3. **Existing User**
   - Key already stored → Upload works immediately

4. **After Logout**
   - Key cleared from storage → Next login retrieves key again

5. **Wrong Key Entered**
   - Dialog shows error → User can retry

6. **Dialog Cancel**
   - Upload cancelled → No key stored → Dialog shown again on next upload

### Manual Testing

```bash
# Clear stored key
# Settings → Logout (clears key)

# Test manual key entry
1. Login
2. Tap "+" or "Sync from Device"
3. Enter key in dialog
4. Verify upload starts

# Test automatic key retrieval
1. Enable key sync in web app
2. Logout from mobile app
3. Login to mobile app
4. Tap "+" or "Sync from Device"
5. Verify upload starts without dialog
```

## API Integration

### Login Response

Backend must return:
```json
{
  "success": true,
  "token": "jwt_token",
  "user": { "id": 1, "username": "user", "email": "user@example.com" },
  "encryptedKey": "base64_encrypted_key",  // Optional
  "encryptedKeySalt": "base64_salt",       // Optional
  "keySyncEnabled": true                    // Optional
}
```

### Key Sync Status

Backend tracks per-user:
- `encryption_key` (encrypted with user password)
- `encryption_key_salt` (for PBKDF2)
- `key_sync_enabled` (boolean flag)

## Future Improvements

1. **Key Rotation** - Allow users to change encryption key
2. **Biometric Unlock** - Use Face ID/Touch ID to access stored key
3. **Key Backup** - Export/import key for device migration
4. **Multiple Keys** - Support different keys for different folders
5. **Key Expiry** - Force key re-entry after X days
6. **Key Strength Validation** - Enforce minimum key complexity

## Migration Notes

Existing users with stored keys:
- Keys remain valid
- No migration needed
- Works seamlessly with new dialog system

New users:
- Will see dialog on first upload
- Can enable key sync in web app for auto-retrieval
- Key stored securely on device

## Troubleshooting

### Key Not Auto-Retrieved After Login

1. Check if key sync is enabled in web app
2. Verify `encryptedKey` and `encryptedKeySalt` in login response
3. Check console for decryption errors
4. Try manual key entry

### Dialog Not Showing

1. Verify `UploadProvider` is in component tree
2. Check `ensureEncryptionKey()` is called before upload
3. Verify `showKeyDialog` state is working

### Key Not Persisting

1. Check secure storage permissions
2. Verify device has secure storage available
3. Check for storage quota errors
4. Try clearing app data and re-entering key

## Support

For issues:
1. Check console logs for detailed errors
2. Verify secure storage is working: `hasEncryptionKey()`
3. Test key decryption manually
4. Check backend API responses
