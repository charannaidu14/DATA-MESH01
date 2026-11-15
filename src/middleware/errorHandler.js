function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  if (status >= 500) {
    console.error(`[Error] ${req.method} ${req.url}:`, err.message);
  }

  res.status(status).json({
    error: message,
    timestamp: new Date().toISOString()
  });
}

module.exports = errorHandler;

