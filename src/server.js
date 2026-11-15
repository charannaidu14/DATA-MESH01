const http = require('http');
const app = require('./app');
const config = require('./config');
const storageNodeService = require('./services/storage-node.service');
const websocketService = require('./services/websocket.service');
const dashboardService = require('./services/dashboard.service');

const server = http.createServer(app);

// Initialize WebSockets
websocketService.initialize(server, '/ws');

// Periodic background polling & broadcasting to connected clients
let pollInterval = null;

function startBackgroundPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      if (websocketService.clients.size > 0) {
        const dashboard = await dashboardService.getDashboard();
        websocketService.broadcast('dashboard.updated', dashboard);
      }
    } catch {}
  }, config.monitoring.pollIntervalMs);
}

// Graceful shutdown
function setupGracefulShutdown(httpServer) {
  const shutdown = signal => {
    console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
    if (pollInterval) clearInterval(pollInterval);
    websocketService.close();

    httpServer.close(() => {
      console.log('[Server] HTTP and WebSocket servers closed. Exiting.');
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${config.server.port} is already in use.`);
  } else {
    console.error('[Server] Fatal server error:', err);
  }
  process.exitCode = 1;
});

function startServer(port = config.server.port, host = config.server.host) {
  return new Promise(resolve => {
    server.listen(port, host, () => {
      storageNodeService.initialize();
      console.log(`====================================================`);
      console.log(` DATA MESH Distributed Storage running on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      console.log(` Active Storage Mode: Built-in Distributed Virtual Mesh (4 Nodes)`);
      console.log(`====================================================`);

      startBackgroundPolling();
      setupGracefulShutdown(server);
      resolve(server);
    });
  });
}

// Auto-start if executed directly
if (require.main === module) {
  startServer().catch(err => {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = {
  server,
  app,
  startServer
};

