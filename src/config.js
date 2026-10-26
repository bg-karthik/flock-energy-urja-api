'use strict';

// Load .env only in non-test environments (Jest provides its own env setup)
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}

const config = {
  portal: {
    baseUrl: process.env.PORTAL_BASE_URL || 'https://urja-ops.flockenergy.tech',
    username: process.env.PORTAL_USERNAME || process.env.URJA_USERNAME,
    password: process.env.PORTAL_PASSWORD || process.env.URJA_PASSWORD,
    timeoutMs: parseInt(process.env.PORTAL_TIMEOUT_MS || '10000', 10),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
};

// Validate required credentials at startup (not in test mode — tests supply their own)
if (config.server.nodeEnv !== 'test') {
  if (!config.portal.username || !config.portal.password) {
    throw new Error(
      'Missing required environment variables: PORTAL_USERNAME and PORTAL_PASSWORD. ' +
      'Copy .env.example to .env and fill in your credentials.'
    );
  }
}

module.exports = config;
