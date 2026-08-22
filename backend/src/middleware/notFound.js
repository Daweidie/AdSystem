function notFound(req, res) {
  res.status(404).json({
    success: false,
    data: null,
    code: 'ROUTE_NOT_FOUND',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

module.exports = notFound;
