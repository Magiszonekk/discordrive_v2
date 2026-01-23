import * as SecureStore from 'expo-secure-store';
import {
  base64ToBytes,
  bytesToBase64,
  deriveKeyPBKDF2,
  decryptAesGcm,
} from './utils';

const KEY_STORAGE_KEY = 'discordrive_encryption_key';
const KEY_DERIVED_AT_KEY = 'discordrive_key_derived_at';

// Store encryption key securely
export async function storeEncryptionKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_STORAGE_KEY, key, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(KEY_DERIVED_AT_KEY, new Date().toISOString());
}

// Get stored encryption key
export async function getEncryptionKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_STORAGE_KEY);
}

// Clear stored encryption key
export async function clearEncryptionKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_STORAGE_KEY);
  await SecureStore.deleteItemAsync(KEY_DERIVED_AT_KEY);
}

// Check if encryption key exists
export async function hasEncryptionKey(): Promise<boolean> {
  const key = await getEncryptionKey();
  return key !== null;
}

// Ensure encryption key exists, throw error if not
export async function ensureEncryptionKey(): Promise<string> {
  const key = await getEncryptionKey();
  if (!key) {
    throw new Error('NO_ENCRYPTION_KEY');
  }
  return key;
}

// Decrypt cloud key with password (PBKDF2 unwrap)
export async function decryptKeyWithPassword(
  encryptedKey: string,
  salt: string,
  password: string
): Promise<string> {
  // Convert base64 to bytes
  const encryptedBytes = base64ToBytes(encryptedKey);
  const saltBytes = base64ToBytes(salt);

  // Derive key using proper PBKDF2-SHA256 with 100000 iterations
  const derivedKey = await deriveKeyPBKDF2(password, saltBytes, 100000);

  // Decrypt using AES-GCM
  // First 12 bytes are IV, rest is ciphertext + auth tag
  const iv = encryptedBytes.slice(0, 12);
  const ciphertext = encryptedBytes.slice(12);

  const decrypted = await decryptAesGcm(ciphertext, derivedKey, iv);
  return bytesToBase64(decrypted);
}

// Encrypt key with password for cloud storage
export async function encryptKeyWithPassword(
  key: string,
  password: string,
  salt: Uint8Array
): Promise<{ encryptedKey: string; salt: string }> {
  const keyBytes = base64ToBytes(key);

  // Derive encryption key using PBKDF2
  const derivedKey = await deriveKeyPBKDF2(password, salt, 100000);

  // Generate random IV
  const { getRandomBytes } = await import('expo-crypto');
  const iv = getRandomBytes(12);

  // Encrypt using AES-GCM
  const { encryptAesGcm } = await import('./utils');
  const { cipher, authTag } = await encryptAesGcm(keyBytes, derivedKey, iv);

  // Combine IV + ciphertext + authTag
  const combined = new Uint8Array(iv.length + cipher.length + authTag.length);
  combined.set(iv, 0);
  combined.set(cipher, iv.length);
  combined.set(authTag, iv.length + cipher.length);

  return {
    encryptedKey: bytesToBase64(combined),
    salt: bytesToBase64(salt),
  };
}
