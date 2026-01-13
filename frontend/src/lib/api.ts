import { FileItem, FilesResponse, Folder, FolderContentsResponse, ShareLink, User } from "@/types";
import { getFilePassword } from "./password-store";
import { clearAuthToken, getAuthToken } from "./auth-storage";

// In production (served by backend): use relative paths
// In development (Next.js dev server): use env variables pointing to backend
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";
export const PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "";

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    if (res.status === 401) {
      clearAuthToken();
    }
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.error || "Request failed");
  }

  return res.json();
}

// Files API
export async function getFiles(folderId?: number | null): Promise<FilesResponse> {
  const params = folderId !== undefined && folderId !== null ? `?folderId=${folderId}` : "";
  return fetchJSON<FilesResponse>(`/files${params}`);
}

export async function getFileInfo(id: number) {
  const password = getFilePassword(id);
  const headers = password ? { "X-File-Password": password } : undefined;
  return fetchJSON<{ success: boolean; file: FileItem }>(`/files/${id}`, { headers });
}

export async function setFilePasswordApi(fileId: number, newPassword: string) {
  const password = getFilePassword(fileId);
  const headers = password ? { "X-File-Password": password } : undefined;
  return fetchJSON<{ success: boolean; message: string }>(`/files/${fileId}/password`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ newPassword }),
  });
}

export async function removeFilePasswordApi(fileId: number, currentPassword: string) {
  const password = getFilePassword(fileId);
  const headers: Record<string, string> = {};
  if (password) headers["X-File-Password"] = password;
  return fetchJSON<{ success: boolean; message: string }>(`/files/${fileId}/password`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ currentPassword }),
  });
}

export async function updateFile(
  id: number,
  data: { folderId?: number | null; originalName?: string }
): Promise<{ success: boolean; file: FileItem }> {
  const password = getFilePassword(id);
  const headers = password ? { "X-File-Password": password } : undefined;
  return fetchJSON(`/files/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers,
  });
}

export async function deleteFile(id: number): Promise<{ success: boolean; message: string }> {
  const password = getFilePassword(id);
  const headers = password ? { "X-File-Password": password } : undefined;
  return fetchJSON(`/files/${id}`, { method: "DELETE", headers });
}

export async function reorderFiles(
  folderId: number | null,
  orderedIds: number[]
): Promise<{ success: boolean; files: FileItem[] }> {
  return fetchJSON("/files/reorder", {
    method: "PATCH",
    body: JSON.stringify({ folderId, orderedIds }),
  });
}

export async function cancelUpload(fileId: number): Promise<{ success: boolean; message: string }> {
  const password = getFilePassword(fileId);
  const headers = password ? { "X-File-Password": password } : undefined;
  return fetchJSON(`/files/${fileId}/cancel`, { method: "POST", headers });
}

export async function cancelDownload(fileId: number): Promise<{ success: boolean; message: string }> {
  const password = getFilePassword(fileId);
  const headers = password ? { "X-File-Password": password } : undefined;
  return fetchJSON(`/files/${fileId}/download/cancel`, { method: "POST", headers });
}

// New client-side encrypted upload endpoints
export async function startUploadSession(params: {
  originalName: string;
  size: number;
  mimeType?: string | null;
  totalParts: number;
  folderId?: number | null;
  encryptionHeader: string;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
}) {
  return fetchJSON<{ success: boolean; fileId: number; totalParts: number; chunkSize: number; batchSize: number; botCount: number; aggressiveMode?: boolean }>(
    "/files",
    {
      method: "POST",
      body: JSON.stringify(params),
    }
  );
}

export async function uploadChunkBatch(
  fileId: number,
  metadata: Array<{ partNumber: number; iv?: string; authTag?: string; plainSize?: number | null }>,
  chunks: Uint8Array[],
  signal?: AbortSignal
) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  chunks.forEach((chunk, idx) => {
    const partLabel = metadata[idx]?.partNumber ?? idx;
    const safeChunk = new Uint8Array(chunk); // ensure ArrayBuffer-backed copy
    form.append(`chunk-${partLabel}`, new Blob([safeChunk]));
  });

  const password = getFilePassword(fileId);
  const headers = password ? { "X-File-Password": password } : undefined;
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}/files/${fileId}/chunks`, {
    method: "POST",
    body: form,
    signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || "Chunk upload failed");
  }

  return res.json();
}

export async function finishUploadSession(fileId: number) {
  const password = getFilePassword(fileId);
  const headers = password ? { "X-File-Password": password } : undefined;
  return fetchJSON<{ success: boolean }>(`/files/${fileId}/finish`, { method: "POST", headers });
}

export async function fetchFilePart(fileId: number, partNumber: number, signal?: AbortSignal) {
  const password = getFilePassword(fileId);
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (password) headers["X-File-Password"] = password;
  const res = await fetch(`${API_BASE}/files/${fileId}/parts/${partNumber}`, { signal, headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch part ${partNumber} (HTTP ${res.status})`);
  }
  return res;
}

// Folders API
export async function getFolders(): Promise<Folder[]> {
  return fetchJSON<Folder[]>("/folders");
}

export async function getFolderContents(id: number): Promise<FolderContentsResponse> {
  return fetchJSON<FolderContentsResponse>(`/folders/${id}/contents`);
}

export async function createFolder(name: string): Promise<Folder> {
  return fetchJSON("/folders", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function updateFolder(id: number, name: string): Promise<Folder> {
  return fetchJSON(`/folders/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteFolder(
  id: number,
  force: boolean = false
): Promise<{ message: string; folder: Folder }> {
  const params = force ? "?force=true" : "";
  return fetchJSON(`/folders/${id}${params}`, { method: "DELETE" });
}

export async function reorderFolders(orderedIds: number[]): Promise<Folder[]> {
  return fetchJSON("/folders/reorder", {
    method: "PATCH",
    body: JSON.stringify({ orderedIds }),
  });
}

// Download URL helper
export function getDownloadUrl(id: number): string {
  const token = getAuthToken();
  const base = `${API_BASE}/files/${id}/download`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function getFolderDownloadUrl(id: number): string {
  const token = getAuthToken();
  const base = `${API_BASE}/folders/${id}/download`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

type ApiShare = {
  id: number;
  token: string;
  file_id?: number | null;
  folder_id?: number | null;
  created_at: string;
  expires_at?: string | null;
  access_count: number;
  file_name?: string | null;
  file_size?: number | null;
  file_mime_type?: string | null;
  folder_name?: string | null;
  require_password?: number | boolean;
  allow_insecure?: number | boolean;
  encrypted_key?: string | null;
  url_key?: string | null;
  media_width?: number | null;
  media_height?: number | null;
  allow_embed?: number | boolean;
};

function transformShare(share: ApiShare): ShareLink {
  return {
    id: share.id,
    token: share.token,
    fileId: share.file_id ?? null,
    folderId: share.folder_id ?? null,
    createdAt: share.created_at,
    expiresAt: share.expires_at ?? null,
    accessCount: share.access_count ?? 0,
    fileName: share.file_name ?? null,
    fileSize: share.file_size ?? null,
    fileMimeType: share.file_mime_type ?? null,
    folderName: share.folder_name ?? null,
    requirePassword: !!share.require_password,
    allowInsecure: !!share.allow_insecure,
    hasWrappedKey: !!share.encrypted_key,
    urlKey: share.url_key ?? null,
    mediaWidth: share.media_width ?? null,
    mediaHeight: share.media_height ?? null,
    allowEmbed: share.allow_embed !== 0,
  };
}

export async function createShareLink(params: {
  fileId?: number;
  folderId?: number;
  encryptedKey: string;
  encryptedKeySalt: string;
  keyWrapMethod?: string;
  requirePassword?: boolean;
  allowInsecure?: boolean;
  urlKey?: string | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  allowEmbed?: boolean;
}): Promise<ShareLink> {
  const payload: Record<string, number | string | boolean | null> = {
    encryptedKey: params.encryptedKey,
    encryptedKeySalt: params.encryptedKeySalt,
    keyWrapMethod: params.keyWrapMethod || "pbkdf2-aes-gcm-100k",
    requirePassword: !!params.requirePassword,
    allowInsecure: !!params.allowInsecure,
    urlKey: params.urlKey ?? null,
    mediaWidth: params.mediaWidth ?? null,
    mediaHeight: params.mediaHeight ?? null,
    allowEmbed: params.allowEmbed !== false,
  };
  const headers: Record<string, string> = {};
  if (typeof params.fileId === "number") {
    payload.fileId = params.fileId;
    const pwd = getFilePassword(params.fileId);
    if (pwd) headers["X-File-Password"] = pwd;
  }
  if (typeof params.folderId === "number") {
    payload.folderId = params.folderId;
  }
  const result = await fetchJSON<{ success: boolean; share: ApiShare }>("/shares", {
    method: "POST",
    body: JSON.stringify(payload),
    headers,
  });
  return transformShare(result.share);
}

export async function getFileShares(fileId: number): Promise<ShareLink[]> {
  const result = await fetchJSON<{ success: boolean; shares: ApiShare[] }>(`/shares/file/${fileId}`);
  return (result.shares || []).map(transformShare);
}

export async function getFolderShares(folderId: number): Promise<ShareLink[]> {
  const result = await fetchJSON<{ success: boolean; shares: ApiShare[] }>(`/shares/folder/${folderId}`);
  return (result.shares || []).map(transformShare);
}

export async function deleteShareLink(id: number): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/shares/${id}`, {
    method: "DELETE",
  });
}

export function getSharePublicUrl(token: string): string {
  // Use browser's current origin (domain/IP) instead of fixed PUBLIC_BASE_URL
  const baseUrl = typeof window !== "undefined" ? window.location.origin : PUBLIC_BASE_URL;
  return `${baseUrl}/s/${token}`;
}

// Stats API
export interface StorageStats {
  totalSize: number;
  totalFiles: number;
  totalSizeFormatted: string;
}

export async function getStorageStats(): Promise<StorageStats> {
  return fetchJSON<StorageStats>("/stats");
}

// Config API - get server configuration for frontend
export interface ServerConfig {
  chunkSize: number;
  maxFileSize: number;
  batchSize: number;
}

let cachedConfig: ServerConfig | null = null;

export async function getServerConfig(): Promise<ServerConfig> {
  if (cachedConfig) return cachedConfig;
  cachedConfig = await fetchJSON<ServerConfig>("/config");
  return cachedConfig;
}

export function clearConfigCache() {
  cachedConfig = null;
}

// Auth API
export async function registerUser(params: { username: string; email: string; password: string }) {
  return fetchJSON<{ success: boolean; message: string }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function loginUser(params: { email: string; password: string }) {
  return fetchJSON<{ success: boolean; token: string; user: User }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function fetchCurrentUser() {
  return fetchJSON<{ success: boolean; user: User }>("/auth/me");
}

export async function requestPasswordReset(email: string) {
  return fetchJSON<{ success: boolean; message: string }>("/auth/reset/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function confirmPasswordReset(token: string, password: string) {
  return fetchJSON<{ success: boolean; message: string }>("/auth/reset/confirm", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

// Password verification API
export async function verifyPassword(password: string): Promise<{ success: boolean; message: string }> {
  return fetchJSON("/auth/verify-password", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

// Key Sync API
export interface KeySyncResponse {
  success: boolean;
  hasKey: boolean;
  keySyncEnabled: boolean;
  encryptedKey?: string;
  salt?: string;
}

export async function getEncryptedKey(): Promise<KeySyncResponse> {
  return fetchJSON<KeySyncResponse>("/auth/key");
}

export async function saveEncryptedKey(params: {
  encryptedKey: string;
  salt: string;
  enabled: boolean;
}): Promise<{ success: boolean; message: string }> {
  return fetchJSON("/auth/key", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function deleteEncryptedKey(): Promise<{ success: boolean; message: string }> {
  return fetchJSON("/auth/key", { method: "DELETE" });
}
