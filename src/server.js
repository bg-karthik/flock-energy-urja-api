'use strict';

/**
 * server.js — HTTP server entry point.
 * Imports the Express app and starts listening on the configured port.
 */

const app = require('./app');
const config = require('./config');

const { port } = config.server;

app.listen(port, () => {
  console.log(`[server] Flock Energy API running on http://localhost:${port}`);
  console.log(`[server] Swagger UI available at http://localhost:${port}/docs`);
  console.log(`[server] Portal: ${config.portal.baseUrl}`);
});
