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
  totalCount: number;
  page: number;
  totalPages: number;
  limit: number;
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
