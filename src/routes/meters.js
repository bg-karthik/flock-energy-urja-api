'use strict';

/**
 * routes/meters.js
 *
 * Implements:
 *   GET /api/v1/meters                   — paginated meter listing
 *   GET /api/v1/meters/:id               — meter detail (nameplate + geo + hierarchy)
 *   GET /api/v1/meters/:id/consumption   — consumption readings
 */

const { Router } = require('express');
const {
  fetchMeterList,
  fetchMeterDetail,
  fetchMeterGeo,
  fetchMeterEnergy,
} = require('../services/portalClient');

const router = Router();

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/** Meter IDs match the pattern J followed by exactly 6 digits, e.g. J100001 */
const METER_ID_RE = /^J\d{6}$/;

function validateMeterId(id) {
  if (!METER_ID_RE.test(id)) {
    const err = new Error(
      `Invalid meter ID format: "${id}". Expected format: J followed by 6 digits (e.g. J100001).`
    );
    err.statusCode = 400;
    throw err;
  }
}

function validatePage(pageStr) {
  const page = parseInt(pageStr || '1', 10);
  if (isNaN(page) || page < 1) {
    const err = new Error('Query parameter "page" must be a positive integer.');
    err.statusCode = 400;
    throw err;
  }
  return page;
}

// ---------------------------------------------------------------------------
// GET /api/v1/meters
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/v1/meters:
 *   get:
 *     summary: List meters
 *     description: Returns a paginated list of smart meters. Proxies /portal/meters/search.
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Search by meter ID or serial number
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Page number (1-indexed, 20 records per page)
 *     responses:
 *       200:
 *         description: Paginated meter list
 *       400:
 *         description: Invalid query parameters
 *       502:
 *         description: Portal communication error
 */
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = validatePage(req.query.page);

    const result = await fetchMeterList(q, page);

    res.json({
      data: result.data,
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/meters/:id
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/v1/meters/{id}:
 *   get:
 *     summary: Get meter detail
 *     description: Returns nameplate, location, and hierarchy for a single meter.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^J\\d{6}$' }
 *         description: Meter ID (e.g. J100001)
 *     responses:
 *       200:
 *         description: Meter detail object
 *       400:
 *         description: Invalid meter ID format
 *       404:
 *         description: Meter not found
 *       502:
 *         description: Portal communication error
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    validateMeterId(id);

    // Fetch nameplate/hierarchy and geo in parallel
    const [detail, geo] = await Promise.all([
      fetchMeterDetail(id),
      fetchMeterGeo(id),
    ]);

    res.json({
      meterId: detail.meterId,
      serialNo: detail.serialNo,
      make: detail.make,
      phaseType: detail.phaseType,
      installStatus: detail.installStatus,
      installType: detail.installType,
      location:
        geo
          ? {
              latitude: parseFloat(geo.latitude),
              longitude: parseFloat(geo.longitude),
            }
          : null,
      hierarchy: detail.hierarchy,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/meters/:id/consumption
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/v1/meters/{id}/consumption:
 *   get:
 *     summary: Get meter consumption history
 *     description: >
 *       Returns all available consumption readings for a meter.
 *       kWh and kVAh are CUMULATIVE meter readings, not interval deltas.
 *       Readings are at 30-minute intervals. Timestamps are in DD/MM/YYYY HH:mm format.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^J\\d{6}$' }
 *         description: Meter ID (e.g. J100001)
 *     responses:
 *       200:
 *         description: Array of consumption readings
 *       400:
 *         description: Invalid meter ID format
 *       404:
 *         description: Meter not found
 *       502:
 *         description: Portal communication error
 */
router.get('/:id/consumption', async (req, res, next) => {
  try {
    const { id } = req.params;
    validateMeterId(id);

    const readings = await fetchMeterEnergy(id);

    res.json({
      meterId: id,
      note: 'kWh and kVAh are cumulative meter readings, not interval deltas. Interval: 30 minutes.',
      count: readings.length,
      data: readings,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
