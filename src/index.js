const express = require('express');
const cors = require('cors');
const path = require('path');

const fs = require('fs');

const { config, validateConfig } = require('./config');
const { initDatabase, closeDatabase } = require('./db');
const { initDiscord, destroyDiscord } = require('./services/discord');
const { shutdownWorkerPool } = require('./services/worker-pool');
const { errorHandler } = require('./middleware/errorHandler');
const { attachUser } = require('./middleware/auth');
const { formatFileSize } = require('./utils/file');
const { cleanupTempDir } = require('./utils/temp');
const { getLogFiles, readLogFile, LOG_DIR } = require('./utils/perfLogger');
const filesRouter = require('./routes/files');
const foldersRouter = require('./routes/folders');
const sharesRouter = require('./routes/shares');
const publicRouter = require('./routes/public');
const authRouter = require('./routes/auth');
const bugsRouter = require('./routes/bugs');

async function main() {
  console.log('Discordrive v2 starting...\n');
  
  // Validate configuration
  validateConfig();
  
  // Initialize database
  initDatabase(config.db.path);
  
  // Initialize Discord
  await initDiscord();

  // Kick off periodic temp cleanup (6h old files, hourly sweep)
  const TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const TEMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  const runTempCleanup = () => cleanupTempDir(config.upload.tempDir, TEMP_MAX_AGE_MS);
  runTempCleanup();
  const tempCleanupInterval = setInterval(runTempCleanup, TEMP_SWEEP_INTERVAL_MS);
  
  // Create Express app
  const app = express();
  
  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(attachUser);
  
  // API routes
  app.use('/api/files', filesRouter);
  app.use('/api/folders', foldersRouter);
  app.use('/api/shares', sharesRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/bugs', bugsRouter);
  app.use('/s', publicRouter);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Storage stats
  app.get('/api/stats', (req, res) => {
    const { getStorageStats } = require('./db');
    const stats = getStorageStats();
    res.json({
      totalSize: stats.totalSize,
      totalFiles: stats.totalFiles,
      totalSizeFormatted: formatFileSize(stats.totalSize),
    });
  });

  // Client config (chunk size, etc.) - allows frontend to match backend settings
  app.get('/api/config', (req, res) => {
    res.json({
      chunkSize: config.upload.chunkSize,
      maxFileSize: config.upload.maxFileSize,
      batchSize: config.upload.batchSize,
    });
  });

  // Performance logs API
  app.get('/api/logs', (req, res) => {
    const files = getLogFiles();
    res.json({
      success: true,
      logDir: LOG_DIR,
      files: files.map(f => ({
        name: f,
        url: `/api/logs/${f}`,
      })),
    });
  });

  app.get('/api/logs/:filename', (req, res) => {
    const { filename } = req.params;
    // Security: only allow .log files from logs directory
    if (!filename.endsWith('.log') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const content = readLogFile(filename);
    if (content === null) {
      return res.status(404).json({ error: 'Log file not found' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  });

  // Serve static frontend
  // Check if Next.js build exists, otherwise fall back to legacy public folder
  const nextBuildPath = path.join(__dirname, '..', 'frontend', 'out');
  const legacyPublicPath = path.join(__dirname, '..', 'public');

  let legacyFrontendServer = null;

  if (fs.existsSync(nextBuildPath)) {
    console.log('Serving Next.js frontend from frontend/out');
    app.use(express.static(nextBuildPath));
    // Handle client-side routing - serve index.html for non-API routes
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(nextBuildPath, 'index.html'));
    });
  } else {
    console.log(`Serving legacy frontend from public/ on http://${config.server.host}:${config.server.legacyFrontendPort}`);
    const legacyApp = express();
    legacyApp.use(express.static(legacyPublicPath));
    legacyApp.get('*', (req, res) => {
      res.sendFile(path.join(legacyPublicPath, 'index.html'));
    });
    legacyFrontendServer = legacyApp.listen(config.server.legacyFrontendPort, config.server.host, () => {
      console.log('Legacy frontend available at http://' + config.server.host + ':' + config.server.legacyFrontendPort);
    });
  }

  // Error handler
  app.use(errorHandler);

  // Start server
  const server = app.listen(config.server.port, config.server.host, () => {
    console.log('\nServer running at http://' + config.server.host + ':' + config.server.port);
    console.log('API endpoints:');
    console.log('  GET    /api/files          - List files & folders');
    console.log('  POST   /api/files          - Upload a file');
    console.log('  PATCH  /api/files/:id      - Update file (move/rename)');
    console.log('  PATCH  /api/files/reorder  - Reorder files');
    console.log('  GET    /api/files/:id      - Get file info');
    console.log('  GET    /api/files/:id/download - Download file');
    console.log('  DELETE /api/files/:id      - Delete a file');
    console.log('  GET    /api/folders        - List folders');
    console.log('  POST   /api/folders        - Create folder');
    console.log('  PATCH  /api/folders/:id    - Update folder');
    console.log('  DELETE /api/folders/:id    - Delete folder');
    console.log('  GET    /api/folders/:id/download - Download folder as ZIP');
    console.log('  PATCH  /api/folders/reorder - Reorder folders');
    console.log('  GET    /api/shares           - List shares');
    console.log('  POST   /api/shares           - Create share');
    console.log('  DELETE /api/shares/:id       - Revoke share');
    console.log('  GET    /s/:token             - Public share download');
    console.log('  GET    /s/:token/info        - Public share metadata');
    console.log('  GET    /api/health         - Health check\n');
  });
  
  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    clearInterval(tempCleanupInterval);
    server.close();
    if (legacyFrontendServer) {
      legacyFrontendServer.close();
    }
    closeDatabase();
    await shutdownWorkerPool();
    await destroyDiscord();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
