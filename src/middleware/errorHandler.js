'use strict';

/**
 * errorHandler.js
 * Express error-handling middleware — must have 4 params (err, req, res, next).
 */

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  // Do not leak internal stack traces to the client in production
  const body = {
    error: {
      status,
      message,
    },
  };

  if (process.env.NODE_ENV === 'development') {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
}

module.exports = errorHandler;
