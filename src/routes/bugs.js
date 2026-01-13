const express = require('express');
const router = express.Router();
const db = require('../db');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

// POST /api/bugs - Submit a bug report
router.post('/', asyncHandler(async (req, res) => {
  const {
    title,
    description,
    stepsToReproduce,
    expectedBehavior,
    actualBehavior,
    browserInfo,
    systemInfo,
    errorLogs,
  } = req.body;

  if (!title || !description) {
    throw new ApiError(400, 'Title and description are required');
  }

  if (title.length > 200) {
    throw new ApiError(400, 'Title must be 200 characters or less');
  }

  if (description.length > 5000) {
    throw new ApiError(400, 'Description must be 5000 characters or less');
  }

  const report = db.createBugReport({
    title: title.trim(),
    description: description.trim(),
    stepsToReproduce: stepsToReproduce?.trim() || null,
    expectedBehavior: expectedBehavior?.trim() || null,
    actualBehavior: actualBehavior?.trim() || null,
    browserInfo: browserInfo || null,
    systemInfo: systemInfo || null,
    errorLogs: errorLogs?.substring(0, 10000) || null, // Limit logs to 10KB
    userId: req.user?.id || null,
    reporterIp: req.ip,
  });

  res.status(201).json({
    success: true,
    message: 'Bug report submitted successfully',
    report: {
      id: report.id,
      title: report.title,
      status: report.status,
      createdAt: report.created_at,
    },
  });
}));

// GET /api/bugs - List all bug reports (requires auth)
router.get('/', asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new ApiError(401, 'Authentication required');
  }

  const { status } = req.query;
  const validStatuses = ['open', 'in_progress', 'resolved', 'closed', 'wont_fix'];

  if (status && !validStatuses.includes(status)) {
    throw new ApiError(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }

  const reports = db.getAllBugReports(status || null);

  res.json({
    success: true,
    reports: reports.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      stepsToReproduce: r.steps_to_reproduce,
      expectedBehavior: r.expected_behavior,
      actualBehavior: r.actual_behavior,
      browserInfo: r.browser_info,
      systemInfo: r.system_info,
      errorLogs: r.error_logs,
      status: r.status,
      reporterUsername: r.reporter_username,
      reporterIp: r.reporter_ip,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
}));

// GET /api/bugs/:id - Get single bug report (requires auth)
router.get('/:id', asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new ApiError(401, 'Authentication required');
  }

  const id = parseInt(req.params.id, 10);
  const report = db.getBugReportById(id);

  if (!report) {
    throw new ApiError(404, 'Bug report not found');
  }

  res.json({
    success: true,
    report: {
      id: report.id,
      title: report.title,
      description: report.description,
      stepsToReproduce: report.steps_to_reproduce,
      expectedBehavior: report.expected_behavior,
      actualBehavior: report.actual_behavior,
      browserInfo: report.browser_info,
      systemInfo: report.system_info,
      errorLogs: report.error_logs,
      status: report.status,
      reporterUsername: report.reporter_username,
      reporterIp: report.reporter_ip,
      createdAt: report.created_at,
      updatedAt: report.updated_at,
    },
  });
}));

// PATCH /api/bugs/:id/status - Update bug report status (requires auth)
router.patch('/:id/status', asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new ApiError(401, 'Authentication required');
  }

  const id = parseInt(req.params.id, 10);
  const { status } = req.body;

  const validStatuses = ['open', 'in_progress', 'resolved', 'closed', 'wont_fix'];
  if (!status || !validStatuses.includes(status)) {
    throw new ApiError(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }

  const report = db.updateBugReportStatus(id, status);

  if (!report) {
    throw new ApiError(404, 'Bug report not found');
  }

  res.json({
    success: true,
    message: 'Status updated',
    report: {
      id: report.id,
      title: report.title,
      status: report.status,
      updatedAt: report.updated_at,
    },
  });
}));

// DELETE /api/bugs/:id - Delete bug report (requires auth)
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new ApiError(401, 'Authentication required');
  }

  const id = parseInt(req.params.id, 10);
  const deleted = db.deleteBugReport(id);

  if (!deleted) {
    throw new ApiError(404, 'Bug report not found');
  }

  res.json({
    success: true,
    message: 'Bug report deleted',
  });
}));

module.exports = router;
