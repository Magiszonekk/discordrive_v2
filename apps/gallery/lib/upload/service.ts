import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { ensureEncryptionKey } from '@/lib/crypto/keys';
import {
  base64ToBytes,
  bytesToBase64,
  deriveKeyBytesPBKDF2,
  encryptAesGcm,
} from '@/lib/crypto/utils';

const DEFAULT_CHUNK_SIZE = 7.5 * 1024 * 1024; // 7.5MB
const MAX_ENCRYPTED_CHUNK = 8 * 1024 * 1024; // 8MB hard ceiling

export interface UploadProgress {
  type: 'start' | 'encrypting' | 'uploading' | 'progress' | 'complete' | 'error';
  progress: number; // 0-100
  currentPart?: number;
  totalParts?: number;
  message?: string;
  fileId?: number;
  error?: string;
  speedBps?: number;
}

export interface EncryptedChunk {
  partNumber: number;
  cipher: Uint8Array;
  iv: string;
  authTag: string;
  plainSize: number;
}

interface UploadSessionResponse {
  success: boolean;
  fileId: number;
  chunkSize?: number;
  batchSize?: number;
  botCount?: number;
  aggressiveMode?: boolean;
}

// Generate random salt for encryption
export function generateSalt(): Uint8Array {
  return Crypto.getRandomBytes(32);
}

// Build encryption header
function buildEncryptionHeader(params: {
  salt: Uint8Array;
  chunkSize: number;
  method: string;
}): string {
  const { salt, chunkSize, method } = params;
  const header = {
    version: 1,
    method,
    salt: bytesToBase64(salt),
    chunkSize,
  };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(header)));
}

// Get media dimensions from file URI
async function getMediaDimensions(
  uri: string,
  mimeType: string
): Promise<{ width: number; height: number } | null> {
  // For React Native, we'll need to use expo-image-manipulator or similar
  // For now, return null - can be enhanced later
  return null;
}

// Get API base URL (same logic as galleryApi)
function getApiBase(): string {
  if (Constants.expoConfig?.extra?.apiBase) {
    return Constants.expoConfig.extra.apiBase;
  }

  // Platform-specific defaults
  if (Platform.OS === 'android') {
    // For Android emulator, 10.0.2.2 maps to host's localhost
    // For physical device, you need to use your computer's IP
    return 'http://10.0.2.2:3000/api';
  }

  if (Platform.OS === 'ios') {
    // iOS simulator can use localhost
    return 'http://localhost:3000/api';
  }

  // Web default
  return 'http://localhost:3000/api';
}

// Start upload session
async function startUploadSession(
  authToken: string,
  params: {
    originalName: string;
    size: number;
    mimeType: string;
    totalParts: number;
    folderId: number | null;
    encryptionHeader: string;
    mediaWidth: number | null;
    mediaHeight: number | null;
  }
): Promise<UploadSessionResponse> {
  const apiBase = getApiBase();
  const response = await fetch(`${apiBase}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to start upload session: ${errorText}`);
  }

  return response.json();
}

// Upload chunk batch using temp files (React Native doesn't support Blob from ArrayBuffer)
async function uploadChunkBatch(
  authToken: string,
  fileId: number,
  metadata: Array<{
    partNumber: number;
    iv: string;
    authTag: string;
    plainSize: number;
  }>,
  buffers: Uint8Array[]
): Promise<void> {
  const apiBase = getApiBase();
  const formData = new FormData();
  formData.append('metadata', JSON.stringify(metadata));

  const timestamp = Date.now();
  const tempPaths: string[] = [];

  // Write each buffer to a temp file and use file URI for FormData
  for (let index = 0; index < buffers.length; index++) {
    const buffer = buffers[index];
    const tempPath = `${FileSystem.cacheDirectory}chunk_${fileId}_${metadata[index].partNumber}_${timestamp}.bin`;
    tempPaths.push(tempPath);

    // Write buffer as base64 to temp file
    await FileSystem.writeAsStringAsync(tempPath, bytesToBase64(buffer), {
      encoding: 'base64',
    });

    // Append file to FormData using React Native format
    formData.append(`chunk_${index}`, {
      uri: tempPath,
      type: 'application/octet-stream',
      name: `chunk_${index}.bin`,
    } as any);
  }

  try {
    const response = await fetch(`${apiBase}/files/${fileId}/chunks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData as any,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload chunk batch: ${errorText}`);
    }
  } finally {
    // Clean up temp files
    for (const tempPath of tempPaths) {
      try {
        await FileSystem.deleteAsync(tempPath, { idempotent: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// Finish upload session
async function finishUploadSession(
  authToken: string,
  fileId: number
): Promise<void> {
  const apiBase = getApiBase();
  const response = await fetch(`${apiBase}/files/${fileId}/finish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to finish upload session');
  }
}

export class UploadService {
  private aborted = false;
  private authToken: string;

  constructor(authToken: string) {
    this.authToken = authToken;
  }

  async uploadFile(
    fileUri: string,
    fileName: string,
    fileSize: number,
    mimeType: string,
    folderId: number | null,
    onProgress: (progress: UploadProgress) => void
  ): Promise<number> {
    this.aborted = false;

    try {
      // Get encryption key (throws if not found)
      const password = await ensureEncryptionKey();

      onProgress({ type: 'start', progress: 0, message: 'Preparing upload...' });

      // Generate encryption parameters
      const salt = generateSalt();
      const method = 'aes-256-gcm';
      const chunkSize = Math.min(
        DEFAULT_CHUNK_SIZE,
        MAX_ENCRYPTED_CHUNK - 1024 - 16
      );
      const header = buildEncryptionHeader({ salt, chunkSize, method });
      const totalParts = Math.max(1, Math.ceil(fileSize / chunkSize));

      // Derive encryption key using proper PBKDF2
      const derivedKey = await deriveKeyBytesPBKDF2(password, salt, 100000);

      onProgress({
        type: 'encrypting',
        progress: 0,
        totalParts,
        message: 'Starting encryption...',
      });

      // Get media dimensions if applicable
      const mediaDims = await getMediaDimensions(fileUri, mimeType);

      // Start upload session
      const startResponse = await startUploadSession(this.authToken, {
        originalName: fileName,
        size: fileSize,
        mimeType,
        totalParts,
        folderId,
        encryptionHeader: header,
        mediaWidth: mediaDims?.width ?? null,
        mediaHeight: mediaDims?.height ?? null,
      });

      const fileId = startResponse.fileId;
      const batchSize = Math.max(1, startResponse.batchSize || 3);

      onProgress({
        type: 'uploading',
        progress: 0,
        totalParts,
        fileId,
        message: 'Uploading...',
      });

      const uploadStart = Date.now();
      let uploadedParts = 0;
      let uploadedBytes = 0;

      // Process file in chunks
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (this.aborted) {
          throw new Error('Upload cancelled');
        }

        const start = (partNumber - 1) * chunkSize;
        const end = Math.min(fileSize, start + chunkSize);

        // Read chunk from file
        const chunkBase64 = await FileSystem.readAsStringAsync(fileUri, {
          encoding: 'base64',
          position: start,
          length: end - start,
        });
        const plainBuffer = base64ToBytes(chunkBase64);

        // Generate IV for this chunk
        const iv = Crypto.getRandomBytes(12);

        // Encrypt chunk using centralized AES-GCM
        const { cipher, authTag } = await encryptAesGcm(
          plainBuffer,
          derivedKey,
          iv
        );

        const encryptedChunk: EncryptedChunk = {
          partNumber,
          cipher,
          iv: bytesToBase64(iv),
          authTag: bytesToBase64(authTag),
          plainSize: plainBuffer.length,
        };

        // Collect chunks into batch
        const batch = [encryptedChunk];

        // Upload batch
        const metadata = batch.map((c) => ({
          partNumber: c.partNumber,
          iv: c.iv,
          authTag: c.authTag,
          plainSize: c.plainSize,
        }));
        const buffers = batch.map((c) => c.cipher);

        await uploadChunkBatch(this.authToken, fileId, metadata, buffers);

        uploadedParts++;
        uploadedBytes += cipher.byteLength;

        const progress = Math.round((uploadedParts / totalParts) * 100);
        const elapsed = Date.now() - uploadStart;
        const speedBps =
          elapsed > 0 ? Math.round((uploadedBytes / elapsed) * 1000) : 0;

        onProgress({
          type: 'progress',
          progress,
          currentPart: uploadedParts,
          totalParts,
          speedBps,
          fileId,
          message: `Uploading ${uploadedParts}/${totalParts} parts...`,
        });
      }

      // Finish upload
      await finishUploadSession(this.authToken, fileId);

      onProgress({
        type: 'complete',
        progress: 100,
        fileId,
        message: 'Upload complete!',
      });

      return fileId;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Upload failed';
      onProgress({
        type: 'error',
        progress: 0,
        error: errorMessage,
        message: errorMessage,
      });
      throw error;
    }
  }

  abort() {
    this.aborted = true;
  }
}
