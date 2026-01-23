import { base64ToBytes, bytesToBase64, deriveKeyPBKDF2 } from './utils';

interface EncryptionHeader {
  method: string;
  chunkSize: number;
  salt: string;
  iterations: number;
}

// Parse encryption header from JSON
export function parseEncryptionHeader(headerStr: string): EncryptionHeader {
  try {
    const header = JSON.parse(headerStr);
    return {
      method: header.method || 'chunked-aes-gcm-12',
      chunkSize: header.chunkSize || 8 * 1024 * 1024 - 1024,
      salt: header.salt || '',
      iterations: header.iterations || 100000,
    };
  } catch {
    return {
      method: 'chunked-aes-gcm-12',
      chunkSize: 8 * 1024 * 1024 - 1024,
      salt: '',
      iterations: 100000,
    };
  }
}

// Derive key from password using PBKDF2
export async function deriveKey(
  password: string,
  saltBase64: string,
  iterations: number
): Promise<CryptoKey> {
  const salt = base64ToBytes(saltBase64);
  return deriveKeyPBKDF2(password, salt, iterations);
}

// Decrypt a single chunk
export async function decryptChunk(
  encryptedData: Uint8Array,
  keyBase64: string,
  ivBase64: string,
  authTagBase64: string,
  header: EncryptionHeader
): Promise<Uint8Array> {
  // Derive the actual encryption key from the stored key
  const derivedKey = await deriveKey(keyBase64, header.salt, header.iterations);

  const iv = base64ToBytes(ivBase64);
  const authTag = base64ToBytes(authTagBase64);

  // Combine ciphertext and auth tag (GCM format)
  const combined = new Uint8Array(encryptedData.length + authTag.length);
  combined.set(encryptedData);
  combined.set(authTag, encryptedData.length);

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    derivedKey,
    combined
  );

  return new Uint8Array(decrypted);
}

// Re-export for backward compatibility
export { base64ToBytes, bytesToBase64 };
