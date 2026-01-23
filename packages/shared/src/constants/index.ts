// Default chunk size: ~8MB (safe for Discord's 25MB bot limit with overhead)
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024 - 1024;

// Maximum file size: 10GB
export const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

// Default concurrent downloads
export const DEFAULT_DOWNLOAD_CONCURRENCY = 6;

// Default batch size for uploads
export const DEFAULT_UPLOAD_BATCH_SIZE = 3;

// Crypto settings
export const PBKDF2_DEFAULT_ITERATIONS = 100_000;
export const MAX_WORKER_COUNT = 8;
export const MIN_WORKER_COUNT = 1;
