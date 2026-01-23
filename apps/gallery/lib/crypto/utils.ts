/**
 * Centralized crypto utilities for React Native
 * Uses Buffer for base64 (not available natively in RN) and
 * crypto.subtle for proper PBKDF2 (from react-native-quick-crypto polyfill)
 */
import { Buffer } from 'buffer';

/**
 * Convert base64 string to Uint8Array
 * React Native doesn't have atob, so we use Buffer
 */
export function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Convert Uint8Array to base64 string
 * React Native doesn't have btoa, so we use Buffer
 */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Derive key using proper PBKDF2-SHA256 via Web Crypto API
 * Uses crypto.subtle from react-native-quick-crypto polyfill
 */
export async function deriveKeyPBKDF2(
  password: string,
  salt: Uint8Array,
  iterations: number = 100000
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);

  // Import password as raw key material for PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  // Derive AES-GCM key using PBKDF2
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt', 'encrypt']
  );
}

/**
 * Derive raw key bytes using PBKDF2-SHA256
 * Returns Uint8Array instead of CryptoKey for cases where raw bytes are needed
 */
export async function deriveKeyBytesPBKDF2(
  password: string,
  salt: Uint8Array,
  iterations: number = 100000,
  keyLength: number = 256
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);

  // Import password as raw key material for PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Derive bits using PBKDF2
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    keyLength
  );

  return new Uint8Array(derivedBits);
}

/**
 * Encrypt data using AES-GCM
 */
export async function encryptAesGcm(
  data: Uint8Array,
  key: CryptoKey | Uint8Array,
  iv: Uint8Array
): Promise<{ cipher: Uint8Array; authTag: Uint8Array }> {
  let cryptoKey: CryptoKey;

  if (key instanceof Uint8Array) {
    cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
  } else {
    cryptoKey = key;
  }

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    cryptoKey,
    data
  );

  // Split ciphertext and auth tag (last 16 bytes)
  const encryptedArray = new Uint8Array(encrypted);
  const cipher = encryptedArray.slice(0, -16);
  const authTag = encryptedArray.slice(-16);

  return { cipher, authTag };
}

/**
 * Decrypt data using AES-GCM
 */
export async function decryptAesGcm(
  ciphertext: Uint8Array,
  key: CryptoKey | Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  let cryptoKey: CryptoKey;

  if (key instanceof Uint8Array) {
    cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
  } else {
    cryptoKey = key;
  }

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );

  return new Uint8Array(decrypted);
}

/**
 * Generate random bytes using expo-crypto
 */
export { getRandomBytes } from 'expo-crypto';
