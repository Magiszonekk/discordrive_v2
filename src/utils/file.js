const { config } = require('../config');

/**
 * Split a buffer into chunks of specified size
 */
function splitBuffer(buffer, chunkSize = config.upload.chunkSize) {
  const chunks = [];
  let offset = 0;
  
  while (offset < buffer.length) {
    const end = Math.min(offset + chunkSize, buffer.length);
    chunks.push(buffer.slice(offset, end));
    offset = end;
  }
  
  return chunks;
}

/**
 * Generate part filename
 */
function getPartFilename(baseName, partNum, totalParts) {
  const partStr = String(partNum).padStart(3, '0');
  const totalStr = String(totalParts).padStart(3, '0');
  return baseName + '.part' + partStr + 'of' + totalStr;
}

/**
 * Extract base name and extension from filename
 */
function parseFilename(filename) {
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
 * Generate unique filename to avoid collisions
 */
function generateUniqueFilename(originalName) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const { name, ext } = parseFilename(originalName);
  return name + '_' + timestamp + '_' + random + ext;
}

/**
 * Get content type from URL via HEAD request
 */
async function getContentType(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.headers.get('content-type');
  } catch {
    return 'application/octet-stream';
  }
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
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
 * Sleep helper for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  splitBuffer,
  getPartFilename,
  parseFilename,
  generateUniqueFilename,
  getContentType,
  formatFileSize,
  sleep,
};
