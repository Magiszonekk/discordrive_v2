const express = require('express');
const cors = require('cors');
const path = require('path');

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
const galleryRouter = require('./routes/gallery');

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
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      // Allow configured frontend URL
      const allowedOrigins = [
        process.env.FRONTEND_URL || 'http://localhost:3001',
        'http://localhost:3001',
      ];

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        // For mobile apps and other clients, allow all origins
        // In production, you might want to restrict this
        callback(null, true);
      }
    },
    credentials: true,
  }));
  app.use(express.json());
  app.use(attachUser);
  
  // API routes
  app.use('/api/files', filesRouter);
  app.use('/api/folders', foldersRouter);
  app.use('/api/shares', sharesRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/bugs', bugsRouter);
  app.use('/api/gallery', galleryRouter);
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
    console.log('  GET    /api/gallery/media    - List media files');
    console.log('  GET    /api/gallery/sync     - Incremental sync');
    console.log('  POST   /api/gallery/sync/ack - Acknowledge sync');
    console.log('  GET    /api/gallery/stats    - Media statistics');
    console.log('  GET    /api/health         - Health check\n');
  });
  
  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    clearInterval(tempCleanupInterval);
    server.close();
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
