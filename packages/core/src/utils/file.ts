/**
 * Generate part filename: "video.mp4.part001of013"
 */
export function getPartFilename(baseName: string, partNum: number, totalParts: number): string {
  const partStr = String(partNum).padStart(3, '0');
  const totalStr = String(totalParts).padStart(3, '0');
  return baseName + '.part' + partStr + 'of' + totalStr;
}

/**
 * Extract base name and extension from filename
 */
export function parseFilename(filename: string): { name: string; ext: string } {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) {
    return { name: filename, ext: '' };
  }
  return {
    name: filename.substring(0, lastDot),
    ext: filename.substring(lastDot),
  };
}

/**
 * Format file size for display (e.g. "1.50 MB")
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return size.toFixed(2) + ' ' + units[unitIndex];
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Guess MIME type from file extension
 */
export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeMap: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    json: 'application/json',
    txt: 'text/plain',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
  };
  return mimeMap[ext] || 'application/octet-stream';
}
