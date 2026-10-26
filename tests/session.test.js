'use strict';

/**
 * tests/session.test.js
 *
 * Tests for the session manager:
 *   - Login success
 *   - Login failure (wrong credentials / unexpected response)
 *   - Session expiry detection
 *   - Session expiry and auto-reauthentication
 *   - At most one retry on persistent auth failure
 */

// Set test env before any module is loaded
process.env.NODE_ENV = 'test';
process.env.PORTAL_USERNAME = 'test@example.com';
process.env.PORTAL_PASSWORD = 'testpassword';
process.env.PORTAL_BASE_URL = 'https://urja-ops.flockenergy.tech';

const {
  login,
  portalGet,
  getClient,
  resetSession,
  isSessionExpired,
} = require('../src/session');

describe('isSessionExpired()', () => {
  test('returns false for a normal 200 JSON response', () => {
    const response = {
      status: 200,
      headers: {},
      data: { data: [] },
    };
    expect(isSessionExpired(response)).toBe(false);
  });

  test('returns true when location header points to /login', () => {
    const response = {
      status: 302,
      headers: { location: '/login' },
      data: '',
    };
    expect(isSessionExpired(response)).toBe(true);
  });

  test('returns true when response body is the login page HTML', () => {
    const response = {
      status: 200,
      headers: {},
      data: '<html><body>Urja Meter Ops <input name="email" /></body></html>',
    };
    expect(isSessionExpired(response)).toBe(true);
  });

  test('returns false when response body is JSON meter data', () => {
    const response = {
      status: 200,
      headers: {},
      data: { data: [{ meterId: 'J100001' }] },
    };
    expect(isSessionExpired(response)).toBe(false);
  });

  test('returns true for absolute /login redirect in location header', () => {
    const response = {
      status: 302,
      headers: { location: 'https://urja-ops.flockenergy.tech/login' },
      data: '',
    };
    expect(isSessionExpired(response)).toBe(true);
  });
});

describe('login()', () => {
  let postSpy;
  let getSpy;
  const client = getClient();

  beforeEach(() => {
    resetSession();
    postSpy = jest.spyOn(client, 'post');
    getSpy = jest.spyOn(client, 'get');
  });

  afterEach(() => {
    postSpy.mockRestore();
    getSpy.mockRestore();
  });

  test('authenticates successfully with SvelteKit action headers and establishes session', async () => {
    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { type: 'redirect', status: 303, location: '/meters' },
    });
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: '<html>Meters Page</html>',
    });

    await expect(login()).resolves.toBeUndefined();

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [url, body, options] = postSpy.mock.calls[0];
    expect(url).toBe('/login');
    expect(body).toContain('email=test%40example.com');
    expect(body).toContain('password=testpassword');
    expect(options.headers['x-sveltekit-action']).toBe('true');
    expect(options.headers['Accept']).toBe('application/json');

    // Follow-up GET to establish cookie
    expect(getSpy).toHaveBeenCalledWith('/meters', expect.any(Object));
  });

  test('throws an error when login credentials fail', async () => {
    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { type: 'failure', status: 400 },
    });

    await expect(login()).rejects.toThrow(/Login failed.*status 200/i);
    expect(getSpy).not.toHaveBeenCalled();
  });

  test('throws an error on upstream 401 or 500 status', async () => {
    postSpy.mockResolvedValueOnce({
      status: 401,
      data: { error: 'Unauthorized' },
    });

    await expect(login()).rejects.toThrow(/Login failed.*status 401/i);
  });
});

describe('portalGet() session management & reauthentication', () => {
  let postSpy;
  let getSpy;
  const client = getClient();

  beforeEach(() => {
    resetSession();
    postSpy = jest.spyOn(client, 'post');
    getSpy = jest.spyOn(client, 'get');
  });

  afterEach(() => {
    postSpy.mockRestore();
    getSpy.mockRestore();
  });

  test('automatically initializes session if not authenticated', async () => {
    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { type: 'redirect', status: 303, location: '/meters' },
    });
    getSpy
      .mockResolvedValueOnce({ status: 200, data: '<html>Meters</html>' }) // login follow-up
      .mockResolvedValueOnce({ status: 200, data: { data: [{ meterId: 'J100001' }] } }); // actual request

    const res = await portalGet('/portal/meters/search?q=&page=1');
    expect(res.status).toBe(200);
    expect(res.data.data[0].meterId).toBe('J100001');
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  test('detects expired session, reauthenticates, and retries the request', async () => {
    // Initial login
    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { type: 'redirect', status: 303, location: '/meters' },
    });
    // Re-auth login
    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { type: 'redirect', status: 303, location: '/meters' },
    });

    getSpy
      // First login follow-up
      .mockResolvedValueOnce({ status: 200, data: '<html>Meters</html>' })
      // Request 1: returns session expired redirect to /login
      .mockResolvedValueOnce({ status: 302, headers: { location: '/login' }, data: '' })
      // Second login follow-up
      .mockResolvedValueOnce({ status: 200, data: '<html>Meters</html>' })
      // Request 1 (retry): succeeds
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: [{ meterId: 'J100001' }] } });

    const res = await portalGet('/portal/meters/search?q=&page=1');
    expect(res.status).toBe(200);
    expect(res.data.data[0].meterId).toBe('J100001');
    // Login was executed twice (initial + reauth)
    expect(postSpy).toHaveBeenCalledTimes(2);
  });

  test('performs at most one retry on session expiry without looping', async () => {
    // Initial login
    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { type: 'redirect', status: 303, location: '/meters' },
    });
    // Re-auth login
    postSpy.mockResolvedValueOnce({
      status: 200,
      data: { type: 'redirect', status: 303, location: '/meters' },
    });

    getSpy
      // First login follow-up
      .mockResolvedValueOnce({ status: 200, data: '<html>Meters</html>' })
      // Request returns expired
      .mockResolvedValueOnce({ status: 302, headers: { location: '/login' }, data: '' })
      // Second login follow-up
      .mockResolvedValueOnce({ status: 200, data: '<html>Meters</html>' })
      // Retry still returns expired (persistent failure)
      .mockResolvedValueOnce({ status: 302, headers: { location: '/login' }, data: '' });

    const res = await portalGet('/portal/meters/search?q=&page=1');
    // Does not loop endlessly, stops after 1 retry and returns the response
    expect(res.status).toBe(302);
    expect(postSpy).toHaveBeenCalledTimes(2);
  });
});
