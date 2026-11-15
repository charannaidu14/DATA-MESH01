const express = require('express');
const path = require('path');
const healthRoutes = require('./routes/health.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const objectsRoutes = require('./routes/objects.routes');
const nodesRoutes = require('./routes/nodes.routes');
const integrityRoutes = require('./routes/integrity.routes');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Standard middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files from the project root
const publicDir = path.resolve(__dirname, '..');
app.use(express.static(publicDir));

// API routes
app.use('/api', healthRoutes);
app.use('/api', dashboardRoutes);
app.use('/api/objects', objectsRoutes);
app.use('/api/nodes', nodesRoutes);
app.use('/api/integrity', integrityRoutes);

// SPA fallback for HTML5 navigation
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    return res.sendFile(path.join(publicDir, 'index.html'));
  }
  next();
});

// Centralized error handler
app.use(errorHandler);

module.exports = app;

