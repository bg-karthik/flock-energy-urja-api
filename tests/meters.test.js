'use strict';

/**
 * tests/meters.test.js
 *
 * Integration-style tests using Supertest + mocked portal client.
 * The portalClient module is mocked — no real HTTP requests are made.
 */

process.env.NODE_ENV = 'test';
process.env.PORTAL_USERNAME = 'test@example.com';
process.env.PORTAL_PASSWORD = 'testpassword';
process.env.PORTAL_BASE_URL = 'https://urja-ops.flockenergy.tech';

const request = require('supertest');
const app = require('../src/app');

// Mock the entire portalClient so no real portal requests are made in unit tests
jest.mock('../src/services/portalClient');
const portalClient = require('../src/services/portalClient');

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const MOCK_METER_LIST = {
  data: [
    { meterId: 'J100001', serialNo: 'GE84132', make: 'L&T', phaseType: 'single', installStatus: 'Installed', dtCode: 'DT-002' },
    { meterId: 'J100002', serialNo: 'AL28136', make: 'L&T', phaseType: 'single', installStatus: 'Installed', dtCode: 'DT-003' },
  ],
  total: 403,
  page: 1,
  pageSize: 20,
};

const MOCK_METER_DETAIL = {
  meterId: 'J100001',
  serialNo: 'GE84132',
  make: 'L&T',
  phaseType: 'single',
  installStatus: 'Installed',
  installType: 'CT Operated',
  hierarchy: {
    zone: 'Jaipur Zone 2 (Z-02)',
    circle: 'Circle 2 (C-02)',
    division: 'Division 2 (D-02)',
    subdivision: 'Subdivision 2 (SD-02)',
    subStation: 'Substation 2 (SS-02)',
    feeder: 'Feeder 2 (F-002)',
    dt: 'Mansarovar DT 2 (DT-002)',
  },
};

const MOCK_GEO = {
  latitude: '26.822136543835608',
  longitude: '75.90718190602279',
};

const MOCK_CONSUMPTION = [
  { timestamp: '23/06/2026 23:30', kwh: 42594.05, kvah: 46001.58, voltR: 231 },
  { timestamp: '24/06/2026 00:00', kwh: 42594.47, kvah: 46002.02, voltR: 230 },
];

// ---------------------------------------------------------------------------
// GET /api/v1/meters
// ---------------------------------------------------------------------------

describe('GET /api/v1/meters', () => {
  beforeEach(() => {
    portalClient.fetchMeterList.mockResolvedValue(MOCK_METER_LIST);
  });

  afterEach(() => jest.clearAllMocks());

  test('returns 200 with paginated meter list', async () => {
    const res = await request(app).get('/api/v1/meters');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].meterId).toBe('J100001');
    expect(res.body.pagination.total).toBe(403);
    expect(res.body.pagination.pageSize).toBe(20);
    expect(res.body.pagination.totalPages).toBe(21);
  });

  test('passes q and page query params to portalClient', async () => {
    await request(app).get('/api/v1/meters?q=J100001&page=2');
    expect(portalClient.fetchMeterList).toHaveBeenCalledWith('J100001', 2);
  });

  test('returns 400 for non-integer page param', async () => {
    const res = await request(app).get('/api/v1/meters?page=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/page/i);
  });

  test('returns 400 for page=0', async () => {
    const res = await request(app).get('/api/v1/meters?page=0');
    expect(res.status).toBe(400);
  });

  test('returns 502 when portal client throws', async () => {
    const err = new Error('Portal unavailable');
    err.statusCode = 502;
    portalClient.fetchMeterList.mockRejectedValue(err);
    const res = await request(app).get('/api/v1/meters');
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain('Portal unavailable');
  });

  test('returns 502 when portal times out', async () => {
    const err = new Error('Upstream portal request timed out');
    err.statusCode = 502;
    err.code = 'ECONNABORTED';
    portalClient.fetchMeterList.mockRejectedValue(err);
    const res = await request(app).get('/api/v1/meters');
    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/meters/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/meters/:id', () => {
  beforeEach(() => {
    portalClient.fetchMeterDetail.mockResolvedValue(MOCK_METER_DETAIL);
    portalClient.fetchMeterGeo.mockResolvedValue(MOCK_GEO);
  });

  afterEach(() => jest.clearAllMocks());

  test('returns 200 with combined meter detail', async () => {
    const res = await request(app).get('/api/v1/meters/J100001');
    expect(res.status).toBe(200);
    expect(res.body.meterId).toBe('J100001');
    expect(res.body.serialNo).toBe('GE84132');
    expect(res.body.make).toBe('L&T');
    expect(res.body.location.latitude).toBeCloseTo(26.822136, 4);
    expect(res.body.location.longitude).toBeCloseTo(75.907181, 4);
    expect(res.body.hierarchy.zone).toBe('Jaipur Zone 2 (Z-02)');
    expect(res.body.hierarchy.dt).toBe('Mansarovar DT 2 (DT-002)');
  });

  test('returns null location when geo returns null', async () => {
    portalClient.fetchMeterGeo.mockResolvedValue(null);
    const res = await request(app).get('/api/v1/meters/J100001');
    expect(res.status).toBe(200);
    expect(res.body.location).toBeNull();
  });

  test('returns 400 for invalid meter ID format', async () => {
    const res = await request(app).get('/api/v1/meters/INVALID');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid meter id/i);
  });

  test('returns 400 for meter ID with wrong digit count', async () => {
    const res = await request(app).get('/api/v1/meters/J1001');
    expect(res.status).toBe(400);
  });

  test('returns 404 when meter does not exist', async () => {
    const err = new Error('Meter not found: J999999');
    err.statusCode = 404;
    portalClient.fetchMeterDetail.mockRejectedValue(err);
    const res = await request(app).get('/api/v1/meters/J999999');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('J999999');
  });

  test('normalizes location coordinates to numbers', async () => {
    const res = await request(app).get('/api/v1/meters/J100001');
    expect(typeof res.body.location.latitude).toBe('number');
    expect(typeof res.body.location.longitude).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/meters/:id/consumption
// ---------------------------------------------------------------------------

describe('GET /api/v1/meters/:id/consumption', () => {
  beforeEach(() => {
    portalClient.fetchMeterEnergy.mockResolvedValue(MOCK_CONSUMPTION);
  });

  afterEach(() => jest.clearAllMocks());

  test('returns 200 with consumption readings', async () => {
    const res = await request(app).get('/api/v1/meters/J100001/consumption');
    expect(res.status).toBe(200);
    expect(res.body.meterId).toBe('J100001');
    expect(res.body.count).toBe(2);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].timestamp).toBe('23/06/2026 23:30');
    expect(res.body.data[0].kwh).toBe(42594.05);
    expect(res.body.data[0].voltR).toBe(231);
  });

  test('includes note about cumulative readings', async () => {
    const res = await request(app).get('/api/v1/meters/J100001/consumption');
    expect(res.body.note).toMatch(/cumulative/i);
  });

  test('returns 400 for invalid meter ID', async () => {
    const res = await request(app).get('/api/v1/meters/BADID/consumption');
    expect(res.status).toBe(400);
  });

  test('returns 404 when meter not found', async () => {
    const err = new Error('Meter not found: J999999');
    err.statusCode = 404;
    portalClient.fetchMeterEnergy.mockRejectedValue(err);
    const res = await request(app).get('/api/v1/meters/J999999/consumption');
    expect(res.status).toBe(404);
  });

  test('returns 502 when portal energy endpoint fails', async () => {
    const err = new Error('Portal energy endpoint failed with status 503');
    err.statusCode = 502;
    portalClient.fetchMeterEnergy.mockRejectedValue(err);
    const res = await request(app).get('/api/v1/meters/J100001/consumption');
    expect(res.status).toBe(502);
  });

  test('kwh and kvah are numbers, not strings', async () => {
    const res = await request(app).get('/api/v1/meters/J100001/consumption');
    const reading = res.body.data[0];
    expect(typeof reading.kwh).toBe('number');
    expect(typeof reading.kvah).toBe('number');
    expect(typeof reading.voltR).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// resolveSkNode (data normalization unit test)
// ---------------------------------------------------------------------------

describe('resolveSkNode()', () => {
  // Unmock to test the real function
  jest.unmock('../src/services/portalClient');
  const { resolveSkNode } = jest.requireActual('../src/services/portalClient');

  test('resolves a simple indexed-reference array', () => {
    // data[0] = {meterId: 1}, data[1] = "J100001"
    // resolve({meterId: 1}) → {meterId: data[1]} → {meterId: "J100001"}
    const dataArray = [{ meterId: 1 }, 'J100001'];
    const result = resolveSkNode(dataArray);
    expect(result).toEqual({ meterId: 'J100001' });
  });

  test('resolves nested arrays of indices', () => {
    // data[0] = [1, 2], data[1] = "a", data[2] = "b"
    const dataArray = [[1, 2], 'a', 'b'];
    const result = resolveSkNode(dataArray);
    expect(result).toEqual(['a', 'b']);
  });

  test('returns primitive values as-is', () => {
    const dataArray = ['hello'];
    expect(resolveSkNode(dataArray)).toBe('hello');
  });

  test('fetchMeterDetail throws 404 when nodes[2] has status 404 error object', async () => {
    const { fetchMeterDetail } = jest.requireActual('../src/services/portalClient');
    const session = require('../src/session');
    const portalGetSpy = jest.spyOn(session, 'portalGet').mockResolvedValueOnce({
      status: 200,
      data: {
        type: 'data',
        nodes: [
          null,
          { type: 'data', data: [] },
          { type: 'error', error: { message: 'Meter not found' }, status: 404 },
        ],
      },
    });

    await expect(fetchMeterDetail('J999999')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Meter not found: J999999',
    });

    portalGetSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Health check and 404
// ---------------------------------------------------------------------------

describe('Health and routing', () => {
  test('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('unknown route returns 404', async () => {
    const res = await request(app).get('/api/v1/unknown');
    expect(res.status).toBe(404);
  });
});
