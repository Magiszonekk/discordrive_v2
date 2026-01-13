const fs = require('fs');
const path = require('path');

// Log directory
const LOG_DIR = path.resolve(process.cwd(), 'data', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Get current log file path (rotates daily)
 */
function getLogFilePath() {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(LOG_DIR, `perf-${date}.log`);
}

/**
 * Format timestamp for log entries
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Write a log entry to file
 */
function writeLog(level, message, data = null) {
  const timestamp = getTimestamp();
  const logFile = getLogFilePath();

  let logLine = `[${timestamp}] [${level}] ${message}`;
  if (data !== null) {
    if (typeof data === 'object') {
      logLine += ' ' + JSON.stringify(data);
    } else {
      logLine += ' ' + String(data);
    }
  }
  logLine += '\n';

  // Also output to console
  if (level === 'PERF') {
    console.log(`[PERF] ${message}`, data !== null ? data : '');
  } else if (level === 'ERROR') {
    console.error(`[${level}] ${message}`, data !== null ? data : '');
  }

  // Append to file (async, non-blocking)
  fs.appendFile(logFile, logLine, (err) => {
    if (err) {
      console.error('Failed to write to log file:', err.message);
    }
  });
}

/**
 * Performance logger object
 */
const perfLogger = {
  timers: new Map(),
  sessionId: null,

  /**
   * Start a new upload session (for grouping logs)
   */
  startSession(fileId, fileName, fileSize) {
    this.sessionId = `${fileId}-${Date.now()}`;
    writeLog('SESSION', `=== UPLOAD SESSION START ===`, {
      sessionId: this.sessionId,
      fileId,
      fileName,
      fileSize,
      fileSizeMB: (fileSize / 1024 / 1024).toFixed(2),
    });
    return this.sessionId;
  },

  /**
   * End the current session
   */
  endSession(summary = {}) {
    writeLog('SESSION', `=== UPLOAD SESSION END ===`, {
      sessionId: this.sessionId,
      ...summary,
    });
    this.sessionId = null;
  },

  /**
   * Start a timer
   */
  start(label) {
    this.timers.set(label, {
      start: Date.now(),
      hrStart: process.hrtime.bigint(),
    });
  },

  /**
   * End a timer and log the result
   */
  end(label, details = null) {
    const timer = this.timers.get(label);
    if (!timer) return 0;

    const durationMs = Date.now() - timer.start;
    this.timers.delete(label);

    const logData = {
      sessionId: this.sessionId,
      label,
      durationMs,
    };
    if (details) {
      logData.details = details;
    }

    writeLog('PERF', `${label}: ${durationMs}ms`, logData);
    return durationMs;
  },

  /**
   * Log a performance metric
   */
  log(message, data = null) {
    const logData = data ? { sessionId: this.sessionId, ...data } : { sessionId: this.sessionId };
    writeLog('PERF', message, logData);
  },

  /**
   * Log an error
   */
  error(message, error = null) {
    const logData = {
      sessionId: this.sessionId,
      error: error?.message || error,
      stack: error?.stack,
    };
    writeLog('ERROR', message, logData);
  },

  /**
   * Log chunk reception details
   */
  logChunksReceived(parts, totalBytes, parseTime) {
    writeLog('PERF', 'Chunks received', {
      sessionId: this.sessionId,
      parts,
      totalBytes,
      totalMB: (totalBytes / 1024 / 1024).toFixed(2),
      parseTimeMs: parseTime,
    });
  },

  /**
   * Log Discord upload details
   */
  logDiscordUpload(botName, parts, totalBytes, attachTime, apiTime, totalTime) {
    const speedMBps = totalTime > 0 ? (totalBytes / 1024 / 1024) / (totalTime / 1000) : 0;
    writeLog('PERF', 'Discord upload', {
      sessionId: this.sessionId,
      bot: botName,
      parts,
      totalBytes,
      totalMB: (totalBytes / 1024 / 1024).toFixed(2),
      attachTimeMs: attachTime,
      apiTimeMs: apiTime,
      totalTimeMs: totalTime,
      speedMBps: speedMBps.toFixed(2),
    });
  },

  /**
   * Log request completion
   */
  logRequestComplete(totalTime, parseTime, discordTime, dbTime, chunkCount) {
    const breakdown = {
      totalMs: totalTime,
      parseMs: parseTime,
      discordMs: discordTime,
      dbMs: dbTime,
      chunks: chunkCount,
    };
    writeLog('PERF', 'Request complete', {
      sessionId: this.sessionId,
      ...breakdown,
      overhead: totalTime - parseTime - discordTime - dbTime,
    });
  },
};

/**
 * Get list of available log files
 */
function getLogFiles() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('.log'))
    .sort()
    .reverse();
}

/**
 * Read a specific log file
 */
function readLogFile(filename) {
  const filePath = path.join(LOG_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Get the latest log file content
 */
function getLatestLog() {
  const files = getLogFiles();
  if (files.length === 0) return null;
  return {
    filename: files[0],
    content: readLogFile(files[0]),
  };
}

module.exports = {
  perfLogger,
  getLogFiles,
  readLogFile,
  getLatestLog,
  LOG_DIR,
};
