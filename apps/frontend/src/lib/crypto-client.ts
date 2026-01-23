import { Buffer } from "buffer";

const STORAGE_KEY = "discordrive_encryption_key";
const STORAGE_METHOD_KEY = "discordrive_encryption_method";
const STORAGE_WORKER_COUNT_KEY = "discordrive_worker_count";

// Default chunk size - can be overridden by NEXT_PUBLIC_CHUNK_SIZE env var
// Default: ~8MB (8*1024*1024 - 1024 = 8387584)
const FALLBACK_CHUNK_SIZE = 8 * 1024 * 1024 - 1024;
export const DEFAULT_CHUNK_SIZE = (() => {
  const envChunkSize = process.env.NEXT_PUBLIC_CHUNK_SIZE;
  if (envChunkSize) {
    const parsed = parseInt(envChunkSize, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return FALLBACK_CHUNK_SIZE;
})();

export const PBKDF2_DEFAULT_ITERATIONS = 100_000;
export const MAX_WORKER_COUNT = 8;
export const MIN_WORKER_COUNT = 1;

export type CryptoMethod =
  | "chunked-aes-gcm-12-fast"
  | "chunked-aes-gcm-12"
  | "chunked-aes-gcm-16"
  | "chunked-aes-gcm-16-strong";

export const DEFAULT_METHOD: CryptoMethod = "chunked-aes-gcm-12";

function getCrypto(): Crypto {
  if (typeof window !== "undefined" && window.crypto?.subtle) {
    return window.crypto as Crypto;
  }
  throw new Error("WebCrypto not available in this environment");
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof window === "undefined") return Buffer.from(bytes).toString("base64");
  return btoa(String.fromCharCode(...bytes));
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof window === "undefined") return new Uint8Array(Buffer.from(base64, "base64"));
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert standard base64 to URL-safe base64 (RFC 4648)
 * Replaces + with -, / with _, and removes padding =
 */
export function toUrlSafeBase64(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert URL-safe base64 back to standard base64
 * Replaces - with +, _ with /, and adds padding
 */
export function fromUrlSafeBase64(urlSafe: string): string {
  let base64 = urlSafe.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  if (padding > 0 && padding < 4) {
    base64 += '='.repeat(padding);
  }
  return base64;
}

export function generateSalt(length = 32): Uint8Array {
  const salt = new Uint8Array(length);
  getCrypto().getRandomValues(salt);
  return salt;
}

function getMethodConfig(method: CryptoMethod) {
  switch (method) {
    case "chunked-aes-gcm-16-strong":
      return { ivLength: 16, tagLength: 16, pbkdf2Iterations: 300_000 };
    case "chunked-aes-gcm-16":
      return { ivLength: 16, tagLength: 16, pbkdf2Iterations: 150_000 };
    case "chunked-aes-gcm-12-fast":
      return { ivLength: 12, tagLength: 16, pbkdf2Iterations: 50_000 };
    case "chunked-aes-gcm-12":
    default:
  return { ivLength: 12, tagLength: 16, pbkdf2Iterations: PBKDF2_DEFAULT_ITERATIONS };
  }
}

function clampWorkerCount(count: number) {
  const rounded = Number.isFinite(count) ? Math.round(count) : MIN_WORKER_COUNT;
  return Math.max(MIN_WORKER_COUNT, Math.min(MAX_WORKER_COUNT, rounded));
}

function detectHardwareConcurrency() {
  if (typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number") {
    return navigator.hardwareConcurrency || 4;
  }
  return 4;
}

export async function deriveKey(password: string, salt: Uint8Array, iterations?: number): Promise<CryptoKey> {
  const subtle = getCrypto().subtle;
  const safeSalt = new Uint8Array(salt); // ensure ArrayBuffer-backed copy
  const keyMaterial = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: safeSalt,
      iterations: iterations ?? PBKDF2_DEFAULT_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptChunk(
  data: Uint8Array,
  key: CryptoKey,
  ivLength: number
): Promise<{ cipher: Uint8Array; iv: Uint8Array; tag: Uint8Array }> {
  const cryptoApi = getCrypto();
  const iv = new Uint8Array(ivLength);
  cryptoApi.getRandomValues(iv);
  const safeData = new Uint8Array(data); // ensure non-shared buffer
  const encrypted = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    safeData
  );
  const cipher = new Uint8Array(encrypted);
  const tagLength = 16;
  const tag = cipher.slice(cipher.length - tagLength);
  return { cipher, iv, tag };
}

export async function decryptChunk(
  cipher: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = getCrypto();
  const safeCipher = new Uint8Array(cipher);
  const safeIv = new Uint8Array(iv);
  const plain = await cryptoApi.subtle.decrypt(
    { name: "AES-GCM", iv: safeIv, tagLength: 128 },
    key,
    safeCipher
  );
  return new Uint8Array(plain);
}

export function ensureEncryptionKey(): string {
  if (typeof window === "undefined") {
    throw new Error("Encryption key required in browser context");
  }
  let key = localStorage.getItem(STORAGE_KEY) || process.env.NEXT_PUBLIC_ENCRYPTION_KEY_DEFAULT || "";
  if (!key) {
    key = window.prompt("Enter encryption key (kept in this browser only):") || "";
    if (!key) {
      throw new Error("Encryption key is required to continue");
    }
  }
  localStorage.setItem(STORAGE_KEY, key);
  return key;
}

export function getStoredKey(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

export function getStoredMethod(): CryptoMethod {
  if (typeof window === "undefined") return DEFAULT_METHOD;
  const stored = localStorage.getItem(STORAGE_METHOD_KEY) as CryptoMethod | null;
  const allowed: CryptoMethod[] = [
    "chunked-aes-gcm-12-fast",
    "chunked-aes-gcm-12",
    "chunked-aes-gcm-16",
    "chunked-aes-gcm-16-strong",
  ];
  return allowed.includes(stored as CryptoMethod) ? (stored as CryptoMethod) : DEFAULT_METHOD;
}

export function saveCryptoPrefs(key: string, method: CryptoMethod) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, key);
  localStorage.setItem(STORAGE_METHOD_KEY, method);
}

export function getDefaultWorkerCount(): number {
  return clampWorkerCount(detectHardwareConcurrency());
}

export function getStoredWorkerCount(): number {
  const fallback = getDefaultWorkerCount();
  if (typeof window === "undefined") return fallback;
  const stored = localStorage.getItem(STORAGE_WORKER_COUNT_KEY);
  const parsed = stored ? parseInt(stored, 10) : NaN;
  if (Number.isFinite(parsed)) {
    return clampWorkerCount(parsed);
  }
  return fallback;
}

export function saveWorkerCountPreference(count: number): number {
  const normalized = clampWorkerCount(count);
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_WORKER_COUNT_KEY, String(normalized));
  }
  return normalized;
}

export function getMethodParams(method?: CryptoMethod) {
  return getMethodConfig(method || getStoredMethod());
}

export function buildEncryptionHeader(params: {
  salt: Uint8Array;
  chunkSize: number;
  method?: CryptoMethod;
}) {
  const method = params.method || getStoredMethod();
  const { ivLength, tagLength, pbkdf2Iterations } = getMethodConfig(method);
  const header = {
    version: "v2-chunked-aes-gcm",
    salt: bytesToBase64(params.salt),
    chunkSize: params.chunkSize,
    ivLength,
    tagLength,
    method,
    pbkdf2Iterations,
  };
  return JSON.stringify(header);
}

export function parseEncryptionHeader(header: string | null | undefined) {
  if (!header) {
    throw new Error("Missing encryption header");
  }
  const parsed = typeof header === "string" ? JSON.parse(header) : header;
  const salt = base64ToBytes(parsed.salt);
  const method = (parsed.method || parsed.version || DEFAULT_METHOD) as CryptoMethod;
  const config = getMethodConfig(method);
  const ivLength = parsed.ivLength || config.ivLength;
  const chunkSize = parsed.chunkSize || DEFAULT_CHUNK_SIZE;
  const version = parsed.version || "unknown";
  const pbkdf2Iterations = parsed.pbkdf2Iterations || config.pbkdf2Iterations || PBKDF2_DEFAULT_ITERATIONS;
  return { salt, ivLength, chunkSize, version, tagLength: parsed.tagLength || config.tagLength, method, pbkdf2Iterations };
}

export function clearStoredKey() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(STORAGE_KEY);
  }
}

// ============================================================================
// Web Worker Pool for parallel encryption
// ============================================================================

interface PendingEncryption {
  resolve: (result: { cipher: Uint8Array; iv: Uint8Array; tag: Uint8Array; plainSize: number }) => void;
  reject: (error: Error) => void;
}

export class CryptoWorkerPool {
  private workers: Worker[] = [];
  private pendingTasks: Map<number, PendingEncryption> = new Map();
  private taskIdCounter = 0;
  private initialized = false;
  private workerIndex = 0;
  private poolSize: number;

  constructor(poolSize = getStoredWorkerCount()) {
    this.poolSize = clampWorkerCount(poolSize);
  }

  async init(password: string, salt: Uint8Array, ivLength: number, pbkdf2Iterations: number): Promise<void> {
    if (this.initialized) {
      this.terminate();
    }

    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(
        new URL("../workers/crypto.worker.ts", import.meta.url),
        { type: "module" }
      );

      worker.onmessage = (event) => this.handleMessage(event);
      worker.onerror = (error) => this.handleError(error, i);

      this.workers.push(worker);

      const initPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Worker init timeout")), 10000);
        const handler = (event: MessageEvent) => {
          if (event.data.type === "init") {
            clearTimeout(timeout);
            worker.removeEventListener("message", handler);
            if (event.data.success) {
              resolve();
            } else {
              reject(new Error(event.data.error || "Worker init failed"));
            }
          }
        };
        worker.addEventListener("message", handler);
      });

      // Convert salt to plain array for transfer (Uint8Array might not transfer correctly)
      worker.postMessage({
        type: "init",
        password,
        salt: Array.from(salt),
        ivLength,
        pbkdf2Iterations,
      });

      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);
    this.initialized = true;
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data;

    if (data.type === "encrypt") {
      const pending = this.pendingTasks.get(data.id);
      if (pending) {
        this.pendingTasks.delete(data.id);
        pending.resolve({
          cipher: new Uint8Array(data.cipher),
          iv: data.iv,
          tag: data.tag,
          plainSize: data.plainSize,
        });
      }
    } else if (data.type === "error") {
      const pending = this.pendingTasks.get(data.id);
      if (pending) {
        this.pendingTasks.delete(data.id);
        pending.reject(new Error(data.error));
      }
    }
  }

  private handleError(error: ErrorEvent, workerIndex: number): void {
    console.error(`Crypto worker ${workerIndex} error:`, error);
  }

  async encrypt(data: Uint8Array): Promise<{ cipher: Uint8Array; iv: Uint8Array; tag: Uint8Array; plainSize: number }> {
    if (!this.initialized || this.workers.length === 0) {
      throw new Error("Worker pool not initialized");
    }

    const taskId = this.taskIdCounter++;
    const worker = this.workers[this.workerIndex];
    this.workerIndex = (this.workerIndex + 1) % this.workers.length;

    return new Promise((resolve, reject) => {
      this.pendingTasks.set(taskId, { resolve, reject });

      // Transfer the buffer to avoid copying
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      worker.postMessage(
        { type: "encrypt", id: taskId, data: buffer },
        [buffer]
      );
    });
  }

  // Encrypt multiple chunks in parallel
  async encryptBatch(chunks: Uint8Array[]): Promise<Array<{ cipher: Uint8Array; iv: Uint8Array; tag: Uint8Array; plainSize: number }>> {
    return Promise.all(chunks.map(chunk => this.encrypt(chunk)));
  }

  terminate(): void {
    for (const worker of this.workers) {
      worker.postMessage({ type: "terminate" });
      worker.terminate();
    }
    this.workers = [];
    this.pendingTasks.clear();
    this.initialized = false;
    this.workerIndex = 0;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get size(): number {
    return this.workers.length;
  }
}

// ============================================================================
// Key Sync - Encrypt/Decrypt encryption key with user password
// ============================================================================

const KEY_SYNC_ENABLED_KEY = "discordrive_key_sync_enabled";

/**
 * Derive a key from password for encrypting the encryption key
 * Uses PBKDF2 with 100,000 iterations
 */
async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const subtle = getCrypto().subtle;
  const keyMaterial = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt the encryption key with user's password
 * Returns: { encryptedKey: base64, salt: base64 }
 */
export async function encryptKeyWithPassword(
  encryptionKey: string,
  password: string
): Promise<{ encryptedKey: string; salt: string }> {
  const cryptoApi = getCrypto();

  // Generate salt for PBKDF2
  const salt = new Uint8Array(32);
  cryptoApi.getRandomValues(salt);

  // Derive key from password
  const derivedKey = await deriveKeyFromPassword(password, salt);

  // Generate IV for AES-GCM
  const iv = new Uint8Array(12);
  cryptoApi.getRandomValues(iv);

  // Encrypt the encryption key
  const keyBytes = new TextEncoder().encode(encryptionKey);
  const encrypted = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    derivedKey,
    keyBytes
  );

  // Combine IV + ciphertext for storage
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return {
    encryptedKey: bytesToBase64(combined),
    salt: bytesToBase64(salt),
  };
}

/**
 * Decrypt the encryption key with user's password
 */
export async function decryptKeyWithPassword(
  encryptedKeyBase64: string,
  saltBase64: string,
  password: string
): Promise<string> {
  const cryptoApi = getCrypto();

  // Decode from base64
  const combined = base64ToBytes(encryptedKeyBase64);
  const salt = base64ToBytes(saltBase64);

  // Extract IV and ciphertext
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  // Derive key from password
  const derivedKey = await deriveKeyFromPassword(password, salt);

  // Decrypt
  const decrypted = await cryptoApi.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    derivedKey,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Get key sync preference from localStorage
 */
export function getKeySyncEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(KEY_SYNC_ENABLED_KEY) === "true";
}

/**
 * Save key sync preference to localStorage
 */
export function setKeySyncEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY_SYNC_ENABLED_KEY, enabled ? "true" : "false");
}
