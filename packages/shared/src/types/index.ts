export interface FileItem {
  id: number;
  name: string;
  originalName: string;
  size: number;
  sizeFormatted: string;
  mimeType: string | null;
  totalParts: number;
  folderId: number | null;
  sortOrder: number;
  createdAt: string;
  locked?: boolean;
  uploaderIp?: string | null;
  userId?: number | null;
  encryptionHeader?: string | null;
  parts?: FilePart[];
  mediaWidth?: number | null;
  mediaHeight?: number | null;
}

export interface FilePart {
  partNumber: number;
  url: string;
  size: number;
  plainSize?: number | null;
  iv?: string | null;
  authTag?: string | null;
}

export interface Folder {
  id: number;
  name: string;
  sort_order: number;
  file_count: number;
  created_at: string;
  user_id?: number | null;
}

export interface FilesResponse {
  success: boolean;
  files: FileItem[];
  folders: Folder[];
  currentFolderId: number | null;
}

export interface FolderContentsResponse {
  folder: Folder;
  files: FileItem[];
}

export interface UploadProgress {
  type: 'status' | 'start' | 'uploading' | 'progress' | 'complete' | 'error';
  message?: string;
  stage?: 'processing' | 'encrypting' | 'splitting' | 'uploading' | 'cancelling';
  percent?: number;
  part?: number;
  totalParts?: number;
  fileId?: number;
  filename?: string;
  totalSize?: number;
  etaMs?: number;
  speedBps?: number;
  file?: FileItem;
  cancelled?: boolean;
}

export interface UploadState {
  id: string;
  file: File;
  status: 'pending' | 'processing' | 'encrypting' | 'uploading' | 'complete' | 'error' | 'cancelled';
  progress: number;
  currentPart?: number;
  totalParts?: number;
  etaMs?: number;
  speedBps?: number;
  message?: string;
  fileId?: number;
  error?: string;
  controller?: AbortController;
  botCount?: number;
  activeBots?: number;
  maxParallelUploads?: number;
  bufferSize?: number;
  bufferMax?: number;
  bufferTarget?: number;
  bufferInFlight?: number;
}

export type ShareResourceType = 'file' | 'folder';

export interface ShareLink {
  id: number;
  token: string;
  fileId: number | null;
  folderId: number | null;
  createdAt: string;
  expiresAt: string | null;
  accessCount: number;
  fileName?: string | null;
  fileSize?: number | null;
  fileMimeType?: string | null;
  folderName?: string | null;
  requirePassword?: boolean;
  allowInsecure?: boolean;
  hasWrappedKey?: boolean;
  urlKey?: string | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  allowEmbed?: boolean;
}

export interface User {
  id: number;
  username: string;
  email: string;
  verified?: boolean;
}

// ==================== GALLERY TYPES ====================

export interface GalleryMediaItem {
  id: number;
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
  totalParts: number;
  folderId: number | null;
  folderName: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  createdAt: string;
  encryptionHeader: string | null;
  // First part data for thumbnail generation
  firstPartUrl: string | null;
  firstPartIv: string | null;
  firstPartAuthTag: string | null;
  // Remote thumbnail data (stored on Discord)
  thumbnailUrl: string | null;
  thumbnailIv: string | null;
  thumbnailAuthTag: string | null;
  thumbnailSize: number | null;
}

export interface GallerySyncResponse {
  success: boolean;
  files: GalleryMediaItem[];
  syncToken: string | null;
  hasMore: boolean;
  lastSyncAt?: string | null;
  serverTime?: string;
  total?: number;
}

export interface GalleryStats {
  totalMedia: number;
  totalSize: number;
  imageCount: number;
  videoCount: number;
  lastSync: string | null;
}

export interface GalleryFolder {
  id: number;
  name: string;
  mediaCount: number;
  createdAt: string;
}

export interface GalleryFoldersResponse {
  success: boolean;
  folders: GalleryFolder[];
  rootMediaCount: number;
}

export interface ThumbnailData {
  id: number;
  originalName: string;
  mimeType: string;
  size: number;
  mediaWidth: number | null;
  mediaHeight: number | null;
  encryptionHeader: string | null;
  firstPartUrl: string | null;
  firstPartIv: string | null;
  firstPartAuthTag: string | null;
}

// Local gallery types (for mobile app SQLite)
export interface LocalMediaItem extends GalleryMediaItem {
  thumbnailPath: string | null;
  thumbnailGeneratedAt: string | null;
  thumbnailUploaded: boolean; // Whether local thumbnail has been uploaded to server
  fullCached: boolean;
  fullCachePath: string | null;
  lastViewedAt: string | null;
  favorite: boolean;
  syncedAt: string;
}

export interface LocalSyncState {
  lastSyncAt: string | null;
  syncToken: string | null;
  totalSynced: number;
}

export type GallerySyncStatus = 'idle' | 'syncing' | 'error';

export interface GallerySyncState {
  status: GallerySyncStatus;
  lastSync: Date | null;
  syncToken: string | null;
  totalItems: number;
  pendingItems: number;
  progress: number;
  error?: string;
}
