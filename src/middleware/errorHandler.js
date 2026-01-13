/**
 * Custom error class for API errors
 */
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'ApiError';
  }
}

/**
 * Express error handling middleware
 */
function errorHandler(err, req, res, next) {
  console.error('Error:', err.message);

  // If headers are already sent (e.g., during streaming), delegate to default handler
  if (res.headersSent) {
    return next(err);
  }
  
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
  }
  
  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    const contentLength = req.headers['content-length'];
    console.error(
      `Multer file too large on ${req.originalUrl} ` +
      (contentLength ? `(Content-Length: ${contentLength} bytes)` : '')
    );
    return res.status(413).json({
      success: false,
      error: 'File too large',
    });
  }
  
  // Generic error
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}

/**
 * Async handler wrapper to catch errors
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { ApiError, errorHandler, asyncHandler };
