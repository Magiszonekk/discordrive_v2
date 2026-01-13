const fs = require('fs');
const path = require('path');

/**
 * Remove files in a temp directory older than maxAgeMs.
 * Silently ignores errors to avoid impacting runtime.
 */
async function cleanupTempDir(dirPath, maxAgeMs) {
  const now = Date.now();
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const removals = entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const fullPath = path.join(dirPath, entry.name);
      try {
        const stats = await fs.promises.stat(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          await fs.promises.unlink(fullPath);
        }
      } catch {
        // ignore individual file errors
      }
    });
    await Promise.all(removals);
  } catch {
    // Ignore directory-level errors (e.g., temp dir missing)
  }
}

module.exports = {
  cleanupTempDir,
};
