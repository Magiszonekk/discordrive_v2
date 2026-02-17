const fs = require('fs');
const path = require('path');

const LOG_FILE = '/tmp/healthcheck.log';

/**
 * Log a healthcheck message to both console and file
 */
function logHealthcheck(message) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} ${message}\n`;

  // Log to console
  console.log(message);

  // Append to log file
  try {
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (err) {
    // Silently fail if can't write to log file
  }
}

/**
 * Clear the healthcheck log file (useful on server start)
 */
function clearHealthcheckLog() {
  try {
    fs.writeFileSync(LOG_FILE, '');
  } catch (err) {
    // Silently fail
  }
}

module.exports = {
  logHealthcheck,
  clearHealthcheckLog,
  LOG_FILE,
};
