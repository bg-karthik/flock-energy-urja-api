'use strict';

/**
 * app.js — Express application setup (without starting the server).
 * Kept separate from server.js so Supertest can import the app without binding a port.
 */

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('../openapi.json');
const metersRouter = require('./routes/meters');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(express.json());

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Swagger UI ---
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// --- API routes ---
app.use('/api/v1/meters', metersRouter);

// --- 404 for unmatched routes ---
app.use((req, res) => {
  res.status(404).json({ error: { status: 404, message: `Route not found: ${req.method} ${req.path}` } });
});

// --- Error handler (must be last) ---
app.use(errorHandler);

module.exports = app;
