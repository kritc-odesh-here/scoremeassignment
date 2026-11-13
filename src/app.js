const express = require('express');
const applicationRoutes = require('./routes/application.routes');
const workflowRoutes = require('./routes/workflow.routes');
const healthRoutes = require('./routes/health.routes');
const { errorHandler } = require('./middleware/error-handler');

function createApp() {
  const app = express();

  // Parse JSON payloads
  app.use(express.json());

  // Mount API Routers
  app.use('/api/v1/applications', applicationRoutes);
  app.use('/api/v1/workflows', workflowRoutes);
  app.use('/api/v1/health', healthRoutes);

  // 404 Route Handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'NotFound',
      message: `Cannot ${req.method} ${req.originalUrl}`
    });
  });

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}

module.exports = {
  createApp
};

