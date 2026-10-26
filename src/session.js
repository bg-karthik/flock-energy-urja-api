'use strict';

/**
 * session.js
 *
 * Manages the authenticated Axios client for the Urja Meter Ops portal.
 *
 * Key protocol facts (from PROTOCOL.md, Playwright-verified 2026-10-26):
 *  - Login: POST /login with x-sveltekit-action: true and Accept: application/json
 *  - Success response: HTTP 200, body {"type":"redirect","status":303,"location":"/meters"}
 *  - Session maintained via cookie jar (HttpOnly cookie set on subsequent GET /meters)
 *  - Session expiry: portal returns HTTP 302/redirect to /login, or 200 with login page HTML
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const config = require('./config');

// One shared cookie jar for the lifetime of this process
const jar = new CookieJar();

// Axios instance with cookie jar support baked in
const client = wrapper(
  axios.create({
    baseURL: config.portal.baseUrl,
    timeout: config.portal.timeoutMs,
    // Do NOT follow redirects automatically — we need to inspect them for session expiry
    maxRedirects: 0,
    validateStatus: status => status < 500, // treat 4xx as non-throwing
    jar,
    withCredentials: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })
);

let isAuthenticated = false;

/**
 * Authenticate with the portal using SvelteKit enhanced form submission.
 *
 * The portal's login uses SvelteKit's use:enhance pattern:
 *  - Must send x-sveltekit-action: true
 *  - Must send Accept: application/json
 *  - Must send Origin: config.portal.baseUrl (SvelteKit CSRF protection check)
 *  - Must send Referer: ${config.portal.baseUrl}/login
 *  - Server responds HTTP 200 with JSON {"type":"redirect","status":303,"location":"/meters"}
 *  - Follow the redirect with a GET to establish the session cookie
 *
 * @throws {Error} if credentials are wrong or portal is unreachable
 */
async function login() {
  const params = new URLSearchParams();
  params.set('email', config.portal.username);
  params.set('password', config.portal.password);

  const response = await client.post('/login', params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-sveltekit-action': 'true',
      'Accept': 'application/json',
      'Origin': config.portal.baseUrl,
      'Referer': `${config.portal.baseUrl}/login`,
    },
    maxRedirects: 0,
    validateStatus: status => status < 500,
  });

  // Verify the SvelteKit redirect JSON response
  const body = response.data;
  const isSuccess =
    response.status === 200 &&
    body &&
    body.type === 'redirect' &&
    body.location === '/meters';

  if (!isSuccess) {
    isAuthenticated = false;
    throw new Error(
      `Login failed. Portal responded with status ${response.status}. ` +
      `Body type: ${body?.type || 'unknown'}`
    );
  }

  // Follow the redirect to establish the session cookie in the jar
  await client.get(body.location, {
    headers: { Accept: 'text/html' },
    maxRedirects: 5,
    validateStatus: status => status < 500,
  });

  isAuthenticated = true;
}

/**
 * Detect whether a portal response indicates the session has expired.
 * The portal redirects expired sessions to /login (HTTP 302 or 200 with login page).
 */
function isSessionExpired(response) {
  // Case 1: explicit redirect to /login
  const location = response.headers && response.headers['location'];
  if (location && location.includes('/login')) return true;

  // Case 2: HTTP 302 to login (if maxRedirects allows us to see it)
  if (response.status === 302 && location && location.includes('/login')) return true;

  // Case 3: Got a 200 but the body is the login page HTML
  if (
    response.status === 200 &&
    typeof response.data === 'string' &&
    response.data.includes('Urja Meter Ops') &&
    response.data.includes('name="email"')
  ) {
    return true;
  }

  return false;
}

/**
 * Make an authenticated GET request to the portal.
 * Automatically reauthenticates once if the session has expired.
 *
 * @param {string} url - Relative URL (e.g. '/portal/meters/search?q=&page=1')
 * @param {object} [options] - Axios request options
 * @returns {object} Axios response
 * @throws {Error} on persistent auth failure or network error
 */
async function portalGet(url, options = {}) {
  if (!isAuthenticated) {
    await login();
  }

  let response = await client.get(url, {
    ...options,
    maxRedirects: 5,
    validateStatus: status => status < 500,
  });

  // Reauthenticate once on session expiry
  if (isSessionExpired(response)) {
    isAuthenticated = false;
    await login();
    response = await client.get(url, {
      ...options,
      maxRedirects: 5,
      validateStatus: status => status < 500,
    });
  }

  return response;
}

/**
 * Expose the raw Axios client for testing purposes.
 * @internal
 */
function getClient() {
  return client;
}

/**
 * Reset session state (for testing only).
 * @internal
 */
function resetSession() {
  isAuthenticated = false;
  jar.removeAllCookiesSync();
}

module.exports = { login, portalGet, getClient, resetSession, isSessionExpired };
