import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { Buffer } from 'buffer';
import type {
  GallerySyncResponse,
  GalleryStats,
  GalleryFoldersResponse,
  ThumbnailData,
} from '@discordrive/shared/types';

// Get API base URL from config or use platform-specific defaults
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

const API_BASE = getApiBase();

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

async function fetchJSON<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

interface LoginResponse {
  success: boolean;
  token?: string;
  user?: {
    id: number;
    username: string;
    email: string;
  };
  message?: string;
  encryptedKey?: string;
  encryptedKeySalt?: string;
  keySyncEnabled?: boolean;
}

interface EncryptionKeyResponse {
  success: boolean;
  enabled: boolean;
  encryptedKey?: string;
  salt?: string;
}

export const galleryApi = {
  // Auth
  login: (email: string, password: string): Promise<LoginResponse> =>
    fetchJSON('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  // Encryption key sync
  getEncryptionKey: (): Promise<EncryptionKeyResponse> =>
    fetchJSON('/auth/encryption-key'),

  saveEncryptionKey: (encryptedKey: string, salt: string, enabled: boolean): Promise<{ success: boolean }> =>
    fetchJSON('/auth/encryption-key', {
      method: 'POST',
      body: JSON.stringify({ encryptedKey, salt, enabled }),
    }),

  deleteEncryptionKey: (): Promise<{ success: boolean }> =>
    fetchJSON('/auth/encryption-key', {
      method: 'DELETE',
    }),

  // Gallery media
  getMedia: (params: {
    since?: string;
    limit?: number;
    folderId?: number | null;
  }): Promise<GallerySyncResponse> => {
    const searchParams = new URLSearchParams();
    if (params.since) searchParams.set('since', params.since);
    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.folderId !== undefined) {
      searchParams.set('folderId', params.folderId === null ? 'null' : params.folderId.toString());
    }
    return fetchJSON(`/gallery/media?${searchParams}`);
  },

  // Sync
  getSync: (params: {
    since?: string;
    limit?: number;
  }): Promise<GallerySyncResponse> => {
    const searchParams = new URLSearchParams();
    if (params.since) searchParams.set('since', params.since);
    if (params.limit) searchParams.set('limit', params.limit.toString());
    return fetchJSON(`/gallery/sync?${searchParams}`);
  },

  ackSync: (syncToken: string): Promise<{ success: boolean }> =>
    fetchJSON('/gallery/sync/ack', {
      method: 'POST',
      body: JSON.stringify({ syncToken }),
    }),

  // Thumbnail data
  getThumbnailData: (mediaId: number): Promise<{ success: boolean; data: ThumbnailData }> =>
    fetchJSON(`/gallery/media/${mediaId}/thumbnail-data`),

  // Stats
  getStats: (): Promise<{ success: boolean; stats: GalleryStats }> =>
    fetchJSON('/gallery/stats'),

  // Folders
  getFolders: (): Promise<GalleryFoldersResponse> =>
    fetchJSON('/gallery/folders'),

  // File part (for decryption)
  getFilePart: async (fileId: number, partNumber: number): Promise<ArrayBuffer> => {
    const response = await fetch(`${API_BASE}/files/${fileId}/parts/${partNumber}`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch part: ${response.status}`);
    }
    return response.arrayBuffer();
  },

  // Get first chunk URL directly (bypasses Discord URL expiration)
  getFirstChunkUrl: (fileId: number): string =>
    `${API_BASE}/files/${fileId}/parts/1`,

  // Delete file
  deleteFile: (fileId: number): Promise<{ success: boolean }> =>
    fetchJSON(`/files/${fileId}`, { method: 'DELETE' }),

  // Upload encrypted thumbnail
  uploadThumbnail: async (
    fileId: number,
    thumbnailData: ArrayBuffer,
    iv: string,
    authTag: string
  ): Promise<{ success: boolean; thumbnail: { url: string; iv: string; authTag: string; size: number } }> => {
    const formData = new FormData();
    formData.append('thumbnail', {
      uri: `data:application/octet-stream;base64,${Buffer.from(thumbnailData).toString('base64')}`,
      type: 'application/octet-stream',
      name: 'thumbnail.enc',
    } as unknown as Blob);
    formData.append('iv', iv);
    formData.append('authTag', authTag);

    const response = await fetch(`${API_BASE}/files/${fileId}/thumbnail`, {
      method: 'POST',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload thumbnail: ${response.status}`);
    }

    return response.json();
  },

  // Get thumbnail info (for downloading)
  getThumbnailInfo: (fileId: number): Promise<{
    success: boolean;
    thumbnail: { url: string; iv: string; authTag: string; size: number };
  }> => fetchJSON(`/files/${fileId}/thumbnail`),

  // Download thumbnail data from Discord URL
  downloadThumbnail: async (url: string): Promise<ArrayBuffer> => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download thumbnail: ${response.status}`);
    }
    return response.arrayBuffer();
  },

  // Folder management
  createFolder: (name: string): Promise<{ success: boolean; folder: { id: number; name: string } }> =>
    fetchJSON('/folders', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  renameFolder: (folderId: number, name: string): Promise<{ success: boolean }> =>
    fetchJSON(`/folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteFolder: (folderId: number): Promise<{ success: boolean }> =>
    fetchJSON(`/folders/${folderId}`, {
      method: 'DELETE',
    }),

  // Move file to folder
  moveFileToFolder: (fileId: number, folderId: number | null): Promise<{ success: boolean }> =>
    fetchJSON(`/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ folderId }),
    }),
};
