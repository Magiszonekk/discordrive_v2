const express = require('express');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const { config } = require('../config');
const db = require('../db');
const discord = require('../services/discord');
const { runHealthcheck, resolvePartUrls } = require('@discordrive/core');

const router = express.Router();

// Track active scans in memory (scanId -> progress state)
const activeScans = new Map();

/**
 * Extract attachment filename from a Discord CDN URL.
 */
function extractFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/');
    return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    const withoutQuery = url.split('?')[0];
    const segments = withoutQuery.split('/');
    return decodeURIComponent(segments[segments.length - 1]);
  }
}

/**
 * POST /scan - Start a new healthcheck scan
 */
router.post('/scan', asyncHandler(async (req, res) => {
  // Only one scan at a time
  if (activeScans.size > 0) {
    throw new ApiError(409, 'A healthcheck scan is already running');
  }

  const { scope = 'all', scopeId, samplePercent, concurrency } = req.body;

  // Validate scope
  if (!['all', 'folder', 'file', 'sample'].includes(scope)) {
    throw new ApiError(400, 'Invalid scope. Must be: all, folder, file, or sample');
  }
  if ((scope === 'folder' || scope === 'file') && !scopeId) {
    throw new ApiError(400, 'scopeId is required for folder/file scope');
  }
  if (scope === 'sample' && (!samplePercent || samplePercent < 1 || samplePercent > 100)) {
    throw new ApiError(400, 'samplePercent must be between 1 and 100');
  }

  // Get parts to check
  let parts = db.getAllPartsForScope(scope, scopeId || null, samplePercent || null);
  if (parts.length === 0) {
    throw new ApiError(404, 'No file parts found for the given scope');
  }

  // Resolve fresh Discord URLs before checking health
  let urlResolutionStatus = 'resolved';
  let urlResolutionError = null;
  try {
    parts = await resolvePartUrls(parts, discord.getPool(), undefined, { graceful: true });
  } catch (err) {
    urlResolutionStatus = 'fallback_cached';
    urlResolutionError = err.message;
    console.warn('[Healthcheck] Failed to resolve fresh URLs, proceeding with cached URLs:', err.message);
  }

  // Create scan record
  const scan = db.createHealthcheckScan(scope, scopeId || null, samplePercent || null, parts.length);

  // Set up in-memory progress tracking
  const scanState = {
    scanId: scan.id,
    status: 'running',
    totalParts: parts.length,
    checkedParts: 0,
    healthyParts: 0,
    unhealthyParts: 0,
    errorParts: 0,
    startTime: Date.now(),
    abortController: new AbortController(),
  };
  activeScans.set(scan.id, scanState);

  // Respond immediately
  res.json({
    success: true,
    scanId: scan.id,
    totalParts: parts.length,
    urlResolutionStatus,
    urlResolutionError,
  });

  // Run scan asynchronously
  const scanConcurrency = concurrency || config.healthcheck.concurrency;

  runHealthcheck(
    parts,
    {
      concurrency: scanConcurrency,
      requestTimeoutMs: config.healthcheck.requestTimeoutMs,
      batchDelayMs: config.healthcheck.batchDelayMs,
    },
    // onProgress
    (checked, total, healthy, unhealthy, errors) => {
      const state = activeScans.get(scan.id);
      if (state) {
        state.checkedParts = checked;
        state.healthyParts = healthy;
        state.unhealthyParts = unhealthy;
        state.errorParts = errors;
      }
    },
    // onBatchReady - flush results to DB
    (results) => {
      try {
        db.insertHealthcheckResultsBatch(scan.id, results);
        const state = activeScans.get(scan.id);
        if (state) {
          db.updateHealthcheckScanProgress(
            scan.id, state.checkedParts, state.healthyParts,
            state.unhealthyParts, state.errorParts,
          );
        }
      } catch (err) {
        console.error('[Healthcheck] Failed to flush batch:', err.message);
      }
    },
    scanState.abortController.signal,
  ).then(({ healthy, unhealthy, errors }) => {
    const state = activeScans.get(scan.id);
    const wasCancelled = state && scanState.abortController.signal.aborted;

    // Final progress update
    db.updateHealthcheckScanProgress(scan.id, state?.checkedParts || 0, healthy, unhealthy, errors);

    if (wasCancelled) {
      db.completeHealthcheckScan(scan.id, 'cancelled', null);
      if (state) state.status = 'cancelled';
    } else {
      db.completeHealthcheckScan(scan.id, 'completed', null);
      if (state) state.status = 'completed';
    }

    console.log(`[Healthcheck] Scan ${scan.id} ${wasCancelled ? 'cancelled' : 'completed'}: ${healthy} healthy, ${unhealthy} unhealthy, ${errors} errors`);

    // Keep in activeScans briefly so SSE clients get the final state
    setTimeout(() => activeScans.delete(scan.id), 10000);
  }).catch((err) => {
    console.error(`[Healthcheck] Scan ${scan.id} error:`, err.message);
    db.completeHealthcheckScan(scan.id, 'error', err.message);
    const state = activeScans.get(scan.id);
    if (state) state.status = 'error';
    setTimeout(() => activeScans.delete(scan.id), 10000);
  });
}));

/**
 * GET /scan/:id/progress - SSE endpoint for scan progress
 */
router.get('/scan/:id/progress', (req, res) => {
  const scanId = parseInt(req.params.id, 10);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const buildPayload = (state) => {
    const elapsed = Date.now() - state.startTime;
    const partsPerSecond = elapsed > 0 ? (state.checkedParts / elapsed) * 1000 : 0;
    const remaining = state.totalParts - state.checkedParts;
    const etaMs = partsPerSecond > 0 ? Math.round((remaining / partsPerSecond) * 1000) : null;
    const percent = state.totalParts > 0
      ? Math.min(100, Math.round((state.checkedParts / state.totalParts) * 100))
      : 0;

    return {
      type: 'progress',
      scanId: state.scanId,
      status: state.status,
      totalParts: state.totalParts,
      checkedParts: state.checkedParts,
      healthyParts: state.healthyParts,
      unhealthyParts: state.unhealthyParts,
      errorParts: state.errorParts,
      percent,
      etaMs,
      partsPerSecond: Math.round(partsPerSecond * 10) / 10,
    };
  };

  const sendProgress = () => {
    const state = activeScans.get(scanId);
    if (state) {
      const payload = buildPayload(state);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  // Send initial state
  sendProgress();

  // Poll for updates every 1s
  const interval = setInterval(sendProgress, 1000);

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(checkComplete);
  });

  // Check for completion
  const checkComplete = setInterval(() => {
    const state = activeScans.get(scanId);
    if (!state || ['completed', 'error', 'cancelled'].includes(state.status)) {
      clearInterval(checkComplete);
      clearInterval(interval);
      if (state) {
        const payload = buildPayload(state);
        payload.type = state.status;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } else {
        // Scan not in memory - check DB
        const scan = db.getHealthcheckScan(scanId);
        if (scan) {
          res.write(`data: ${JSON.stringify({ type: scan.status, scanId, ...scan })}\n\n`);
        }
      }
      res.end();
    }
  }, 500);
});

/**
 * POST /scan/:id/cancel - Cancel a running scan
 */
router.post('/scan/:id/cancel', asyncHandler(async (req, res) => {
  const scanId = parseInt(req.params.id, 10);
  const state = activeScans.get(scanId);

  if (state && state.status === 'running') {
    state.abortController.abort();
    state.status = 'cancelled';
    console.log(`[Healthcheck] Cancel requested for scan ${scanId}`);
    res.json({ success: true, message: 'Scan cancellation requested' });
  } else {
    res.json({ success: false, message: 'No active scan found with that ID' });
  }
}));

/**
 * GET /scan/:id - Get scan results/summary
 */
router.get('/scan/:id', asyncHandler(async (req, res) => {
  const scanId = parseInt(req.params.id, 10);

  // Check in-memory first for active scans
  const state = activeScans.get(scanId);
  if (state) {
    const elapsed = Date.now() - state.startTime;
    return res.json({
      success: true,
      scan: {
        id: scanId,
        status: state.status,
        totalParts: state.totalParts,
        checkedParts: state.checkedParts,
        healthyParts: state.healthyParts,
        unhealthyParts: state.unhealthyParts,
        errorParts: state.errorParts,
        healthPercent: state.checkedParts > 0
          ? Math.round((state.healthyParts / state.checkedParts) * 10000) / 100
          : 0,
        durationMs: elapsed,
      },
    });
  }

  // Check DB for completed scans
  const scan = db.getHealthcheckScan(scanId);
  if (!scan) {
    throw new ApiError(404, 'Scan not found');
  }

  const checkedParts = scan.checked_parts || 0;
  const httpStatusDistribution = db.getHttpStatusDistribution(scanId);
  res.json({
    success: true,
    scan: {
      id: scan.id,
      status: scan.status,
      scope: scan.scope,
      scopeId: scan.scope_id,
      samplePercent: scan.sample_percent,
      totalParts: scan.total_parts,
      checkedParts: checkedParts,
      healthyParts: scan.healthy_parts,
      unhealthyParts: scan.unhealthy_parts,
      errorParts: scan.error_parts,
      healthPercent: checkedParts > 0
        ? Math.round((scan.healthy_parts / checkedParts) * 10000) / 100
        : 0,
      startedAt: scan.started_at,
      completedAt: scan.completed_at,
      createdAt: scan.created_at,
      errorMessage: scan.error_message,
      httpStatusDistribution: httpStatusDistribution.map(d => ({
        httpStatus: d.http_status,
        status: d.status,
        count: d.count,
      })),
    },
  });
}));

/**
 * GET /scan/:id/files - Get unhealthy files for a scan
 */
router.get('/scan/:id/files', asyncHandler(async (req, res) => {
  const scanId = parseInt(req.params.id, 10);
  const scan = db.getHealthcheckScan(scanId);
  if (!scan) {
    throw new ApiError(404, 'Scan not found');
  }

  const files = db.getUnhealthyFiles(scanId);
  res.json({
    success: true,
    files: files.map(f => ({
      fileId: f.file_id,
      fileName: f.file_name,
      fileSize: f.file_size,
      totalParts: f.total_parts,
      missingParts: f.missing_parts,
      missingPartNumbers: f.missing_part_numbers ? f.missing_part_numbers.split(',').map(Number) : [],
    })),
  });
}));

/**
 * GET /scan/:id/files/:fileId - Get part-level results for a specific file
 */
router.get('/scan/:id/files/:fileId', asyncHandler(async (req, res) => {
  const scanId = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);

  const results = db.getHealthcheckResultsForFile(scanId, fileId);
  res.json({
    success: true,
    results: results.map(r => ({
      partNumber: r.part_number,
      status: r.status,
      httpStatus: r.http_status,
      responseTimeMs: r.response_time_ms,
      discordUrl: r.discord_url,
    })),
  });
}));

/**
 * GET /scans - List recent scans (history)
 */
router.get('/scans', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  const scans = db.getHealthcheckScans(limit);
  res.json({
    success: true,
    scans: scans.map(s => ({
      id: s.id,
      status: s.status,
      scope: s.scope,
      scopeId: s.scope_id,
      samplePercent: s.sample_percent,
      totalParts: s.total_parts,
      checkedParts: s.checked_parts,
      healthyParts: s.healthy_parts,
      unhealthyParts: s.unhealthy_parts,
      errorParts: s.error_parts,
      healthPercent: s.checked_parts > 0
        ? Math.round((s.healthy_parts / s.checked_parts) * 10000) / 100
        : 0,
      startedAt: s.started_at,
      completedAt: s.completed_at,
      createdAt: s.created_at,
      errorMessage: s.error_message,
    })),
  });
}));

/**
 * DELETE /scan/:id - Delete a scan and its results
 */
router.delete('/scan/:id', asyncHandler(async (req, res) => {
  const scanId = parseInt(req.params.id, 10);

  // Don't allow deleting active scans
  if (activeScans.has(scanId)) {
    throw new ApiError(409, 'Cannot delete an active scan. Cancel it first.');
  }

  const deleted = db.deleteHealthcheckScan(scanId);
  if (!deleted) {
    throw new ApiError(404, 'Scan not found');
  }

  res.json({ success: true });
}));

/**
 * POST /diagnose - Run layered diagnostic to determine why parts are unhealthy
 */
router.post('/diagnose', asyncHandler(async (req, res) => {
  const { sampleSize = 5, fileId } = req.body;
  const limit = Math.min(Math.max(1, sampleSize), 20);

  // Get sample parts
  let parts;
  if (fileId) {
    const file = db.getFileById(fileId);
    if (!file) throw new ApiError(404, 'File not found');
    parts = (file.parts || []).slice(0, limit);
  } else {
    parts = db.getSampleParts(limit);
  }

  if (parts.length === 0) {
    throw new ApiError(404, 'No file parts found');
  }

  const results = [];
  for (const part of parts) {
    const diag = {
      partId: part.id,
      fileId: part.file_id,
      partNumber: part.part_number,
      messageId: part.message_id,
      // Layer 1: Can we fetch the Discord message?
      messageFetch: { success: false, error: null, attachmentCount: 0 },
      // Layer 2: Did we get a fresh URL?
      urlResolution: { success: false, freshUrl: null, error: null },
      // Layer 3: Does the fresh URL respond to HEAD?
      freshUrlCheck: { success: false, httpStatus: null, error: null },
      // Layer 4: Does the cached/old URL respond to HEAD?
      cachedUrlCheck: { success: false, httpStatus: null, error: null },
    };

    // Layer 1: Fetch Discord message
    try {
      const message = await discord.fetchMessage(part.message_id);
      if (message) {
        const attachments = Array.from(message.attachments.values());
        diag.messageFetch = { success: true, error: null, attachmentCount: attachments.length };

        // Layer 2: Try to match attachment
        const filename = extractFilenameFromUrl(part.discord_url);
        const match = attachments.find(a => a.name === filename);
        if (match) {
          diag.urlResolution = { success: true, freshUrl: match.url, error: null };
        } else if (attachments.length > 0) {
          diag.urlResolution = { success: true, freshUrl: attachments[0].url, error: 'matched by index, not filename' };
        } else {
          diag.urlResolution = { success: false, freshUrl: null, error: 'message has 0 attachments' };
        }
      } else {
        diag.messageFetch = { success: false, error: 'message not found (null)', attachmentCount: 0 };
      }
    } catch (err) {
      diag.messageFetch = { success: false, error: err.message, attachmentCount: 0 };
    }

    // Layer 3: HEAD on fresh URL (if resolved)
    if (diag.urlResolution.freshUrl) {
      try {
        const resp = await fetch(diag.urlResolution.freshUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
        diag.freshUrlCheck = { success: resp.ok, httpStatus: resp.status, error: null };
      } catch (err) {
        diag.freshUrlCheck = { success: false, httpStatus: null, error: err.message };
      }
    }

    // Layer 4: HEAD on cached URL
    try {
      const resp = await fetch(part.discord_url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      diag.cachedUrlCheck = { success: resp.ok, httpStatus: resp.status, error: null };
    } catch (err) {
      diag.cachedUrlCheck = { success: false, httpStatus: null, error: err.message };
    }

    results.push(diag);
  }

  // Summary
  const summary = {
    totalSampled: results.length,
    messagesFound: results.filter(r => r.messageFetch.success).length,
    urlsResolved: results.filter(r => r.urlResolution.success).length,
    freshUrlsHealthy: results.filter(r => r.freshUrlCheck.success).length,
    cachedUrlsHealthy: results.filter(r => r.cachedUrlCheck.success).length,
  };

  // Automated diagnosis
  let diagnosis;
  if (summary.messagesFound === 0) {
    diagnosis = 'MESSAGES_DELETED — Discord messages not found. Data may have been deleted from Discord, or bots lack channel access.';
  } else if (summary.messagesFound > 0 && summary.urlsResolved === 0) {
    diagnosis = 'ATTACHMENTS_MISSING — Messages exist but have no attachments. Files may have been stripped.';
  } else if (summary.urlsResolved > 0 && summary.freshUrlsHealthy === 0) {
    diagnosis = 'FRESH_URLS_FAILING — Resolved fresh URLs but HEAD requests fail. Possible Discord CDN issue or rate limiting.';
  } else if (summary.freshUrlsHealthy > 0) {
    diagnosis = 'FILES_OK — Files are accessible via Discord. Previous healthcheck may have used expired cached URLs.';
  } else {
    diagnosis = 'MIXED — Some files accessible, some not. Run a full scan with URL resolution for details.';
  }

  res.json({ success: true, diagnosis, summary, results });
}));

module.exports = router;
