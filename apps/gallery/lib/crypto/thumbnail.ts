import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Buffer } from 'buffer';
import { galleryApi } from '@/lib/api/client';
import { getEncryptionKey } from './keys';
import { decryptChunk, parseEncryptionHeader } from './decrypt';
import { bytesToBase64, base64ToBytes } from './utils';
import * as db from '@/lib/storage/database';

const THUMBNAIL_DIR = `${FileSystem.documentDirectory}thumbnails/`;

interface ThumbnailJob {
  mediaId: number;
  mimeType: string;
  encryptionHeader: string | null;
  firstPartIv: string | null;
  firstPartAuthTag: string | null;
}

// Ensure thumbnail directory exists
export async function ensureThumbnailDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(THUMBNAIL_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(THUMBNAIL_DIR, { intermediates: true });
  }
}

// Get thumbnail path for a media item
export function getThumbnailPath(mediaId: number): string {
  return `${THUMBNAIL_DIR}${mediaId}.webp`;
}

// Generate thumbnail for a media item
export async function generateThumbnail(job: ThumbnailJob): Promise<string> {
  await ensureThumbnailDir();

  const thumbnailPath = getThumbnailPath(job.mediaId);

  // Check if thumbnail already exists
  const info = await FileSystem.getInfoAsync(thumbnailPath);
  if (info.exists) {
    return thumbnailPath;
  }

  // Only support images for now
  if (!job.mimeType.startsWith('image/')) {
    throw new Error('Only image thumbnails are supported');
  }

  // Get encryption key
  const encryptionKey = await getEncryptionKey();
  if (!encryptionKey) {
    throw new Error('Encryption key not found');
  }

  // Fetch first chunk from server
  const chunkData = await galleryApi.getFilePart(job.mediaId, 1);

  // Decrypt the chunk
  let decryptedData: Uint8Array;

  if (job.encryptionHeader && job.firstPartIv && job.firstPartAuthTag) {
    const header = parseEncryptionHeader(job.encryptionHeader);
    decryptedData = await decryptChunk(
      new Uint8Array(chunkData),
      encryptionKey,
      job.firstPartIv,
      job.firstPartAuthTag,
      header
    );
  } else {
    // Unencrypted file
    decryptedData = new Uint8Array(chunkData);
  }

  // Convert to base64 data URI
  const base64 = bytesToBase64(decryptedData);
  const mimeType = job.mimeType || 'image/jpeg';
  const dataUri = `data:${mimeType};base64,${base64}`;

  // Resize image to thumbnail
  const manipulated = await ImageManipulator.manipulateAsync(
    dataUri,
    [{ resize: { width: 300, height: 300 } }],
    { format: ImageManipulator.SaveFormat.WEBP, compress: 0.7 }
  );

  // Move to thumbnail directory
  await FileSystem.moveAsync({
    from: manipulated.uri,
    to: thumbnailPath,
  });

  // Update database with local thumbnail path
  await db.updateThumbnailPath(job.mediaId, thumbnailPath);

  // Try to upload thumbnail to server in background (don't wait)
  uploadThumbnailToServer(job.mediaId).catch((err) => {
    console.log(`Background thumbnail upload failed for ${job.mediaId}:`, err);
  });

  return thumbnailPath;
}

// Clear all thumbnails
export async function clearAllThumbnails(): Promise<void> {
  try {
    await FileSystem.deleteAsync(THUMBNAIL_DIR, { idempotent: true });
    await ensureThumbnailDir();
  } catch (error) {
    console.error('Failed to clear thumbnails:', error);
  }
}

// Get thumbnail storage size
export async function getThumbnailStorageSize(): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(THUMBNAIL_DIR);
    return (info as { size?: number }).size || 0;
  } catch {
    return 0;
  }
}

// Encrypt thumbnail data for upload
async function encryptThumbnail(
  thumbnailData: Uint8Array,
  encryptionKey: CryptoKey
): Promise<{ encryptedData: ArrayBuffer; iv: string; authTag: string }> {
  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt using AES-GCM
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    encryptionKey,
    thumbnailData
  );

  // The last 16 bytes are the auth tag
  const encrypted = new Uint8Array(encryptedBuffer);
  const ciphertext = encrypted.slice(0, -16);
  const authTag = encrypted.slice(-16);

  // Combine IV + ciphertext + authTag for storage
  const combined = new Uint8Array(iv.length + ciphertext.length + authTag.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  combined.set(authTag, iv.length + ciphertext.length);

  return {
    encryptedData: combined.buffer,
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
  };
}

// Upload encrypted thumbnail to server
export async function uploadThumbnailToServer(mediaId: number): Promise<boolean> {
  try {
    const thumbnailPath = getThumbnailPath(mediaId);

    // Check if thumbnail exists locally
    const info = await FileSystem.getInfoAsync(thumbnailPath);
    if (!info.exists) {
      console.log(`No local thumbnail for ${mediaId}`);
      return false;
    }

    // Get encryption key
    const encryptionKey = await getEncryptionKey();
    if (!encryptionKey) {
      console.error('Encryption key not found for thumbnail upload');
      return false;
    }

    // Read thumbnail file
    const base64Data = await FileSystem.readAsStringAsync(thumbnailPath, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const thumbnailData = base64ToBytes(base64Data);

    // Encrypt thumbnail
    const { encryptedData, iv, authTag } = await encryptThumbnail(thumbnailData, encryptionKey);

    // Upload to server
    const result = await galleryApi.uploadThumbnail(mediaId, encryptedData, iv, authTag);

    if (result.success) {
      // Mark as uploaded in local database
      await db.markThumbnailUploaded(
        mediaId,
        result.thumbnail.url,
        result.thumbnail.iv,
        result.thumbnail.authTag,
        result.thumbnail.size
      );
      console.log(`Thumbnail uploaded for ${mediaId}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`Failed to upload thumbnail for ${mediaId}:`, error);
    return false;
  }
}

// Decrypt thumbnail data from server
async function decryptThumbnail(
  encryptedData: ArrayBuffer,
  iv: string,
  authTag: string,
  encryptionKey: CryptoKey
): Promise<Uint8Array> {
  const ivBytes = base64ToBytes(iv);
  const authTagBytes = base64ToBytes(authTag);
  const encrypted = new Uint8Array(encryptedData);

  // Skip IV at start, extract ciphertext
  const ciphertext = encrypted.slice(ivBytes.length, -authTagBytes.length);

  // Combine ciphertext + authTag for decryption
  const combined = new Uint8Array(ciphertext.length + authTagBytes.length);
  combined.set(ciphertext, 0);
  combined.set(authTagBytes, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
    encryptionKey,
    combined
  );

  return new Uint8Array(decrypted);
}

// Download thumbnail from server and save locally
export async function downloadThumbnailFromServer(
  mediaId: number,
  thumbnailUrl: string,
  thumbnailIv: string,
  thumbnailAuthTag: string
): Promise<string | null> {
  try {
    await ensureThumbnailDir();
    const thumbnailPath = getThumbnailPath(mediaId);

    // Check if thumbnail already exists locally
    const info = await FileSystem.getInfoAsync(thumbnailPath);
    if (info.exists) {
      return thumbnailPath;
    }

    // Get encryption key
    const encryptionKey = await getEncryptionKey();
    if (!encryptionKey) {
      console.error('Encryption key not found for thumbnail download');
      return null;
    }

    // Download encrypted thumbnail from Discord
    const encryptedData = await galleryApi.downloadThumbnail(thumbnailUrl);

    // Decrypt thumbnail
    const decryptedData = await decryptThumbnail(
      encryptedData,
      thumbnailIv,
      thumbnailAuthTag,
      encryptionKey
    );

    // Save to local file
    const base64 = bytesToBase64(decryptedData);
    await FileSystem.writeAsStringAsync(thumbnailPath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // Update database with local path
    await db.updateThumbnailPath(mediaId, thumbnailPath);

    console.log(`Thumbnail downloaded for ${mediaId}`);
    return thumbnailPath;
  } catch (error) {
    console.error(`Failed to download thumbnail for ${mediaId}:`, error);
    return null;
  }
}

// Sync thumbnails - upload local thumbnails and download missing ones
export async function syncThumbnails(): Promise<{ uploaded: number; downloaded: number }> {
  let uploaded = 0;
  let downloaded = 0;

  // Upload local thumbnails that haven't been uploaded
  const toUpload = await db.getMediaWithUnuploadedThumbnails(20);
  for (const media of toUpload) {
    const success = await uploadThumbnailToServer(media.id);
    if (success) uploaded++;
  }

  // Download thumbnails from server that we don't have locally
  const toDownload = await db.getMediaWithMissingLocalThumbnails(20);
  for (const media of toDownload) {
    if (media.thumbnailUrl && media.thumbnailIv && media.thumbnailAuthTag) {
      const path = await downloadThumbnailFromServer(
        media.id,
        media.thumbnailUrl,
        media.thumbnailIv,
        media.thumbnailAuthTag
      );
      if (path) downloaded++;
    }
  }

  return { uploaded, downloaded };
}

