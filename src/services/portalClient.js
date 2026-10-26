'use strict';

/**
 * portalClient.js
 *
 * Thin wrappers around the verified /portal/* internal JSON APIs.
 *
 * Verified portal endpoints (PROTOCOL.md, 2026-10-26):
 *   GET /portal/meters/search?q=&page=N  — paginated meter list
 *   GET /portal/meters/{id}/geo          — lat/lng
 *   GET /portal/meters/{id}/energy       — consumption readings
 *   GET /portal/dts?page=N               — transformer list
 *   GET /meters/{id}/__data.json         — nameplate + hierarchy (SvelteKit format)
 */

const session = require('../session');

/**
 * Resolve SvelteKit's indexed-reference __data.json format into a plain object.
 *
 * SvelteKit serialises its load() return value as a flat array where objects
 * reference other entries by their index. For example:
 *   data: [{"meterId": 1}, "J100001", ...]
 * means: { meterId: "J100001" } (index 1 → "J100001").
 *
 * This resolver walks the flat array and reconstructs nested objects/arrays.
 *
 * @param {Array} dataArray - The flat `data` array from a __data.json node
 * @returns {*} The resolved root value (index 0)
 */
function resolveSkNode(dataArray) {
  function resolve(value) {
    if (Array.isArray(value)) {
      return value.map(item =>
        typeof item === 'number' ? resolve(dataArray[item]) : resolve(item)
      );
    }
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = typeof v === 'number' ? resolve(dataArray[v]) : resolve(v);
      }
      return out;
    }
    return value;
  }
  return resolve(dataArray[0]);
}

/**
 * Fetch the paginated meter listing from the portal.
 *
 * @param {string} q    - Search query (meter ID or serial, may be empty)
 * @param {number} page - Page number (1-indexed)
 * @returns {{ data: object[], total: number, page: number, pageSize: number }}
 */
async function fetchMeterList(q = '', page = 1) {
  const params = new URLSearchParams({ q, page: String(page) });
  const response = await session.portalGet(`/portal/meters/search?${params}`);

  if (response.status !== 200) {
    const err = new Error(`Portal meter search failed with status ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  return response.data; // { data, total, page, pageSize }
}

/**
 * Fetch meter nameplate and hierarchy from /meters/{id}/__data.json.
 * Decodes the SvelteKit indexed-reference format.
 *
 * @param {string} meterId
 * @returns {{ meterId, serialNo, make, phaseType, installStatus, installType, hierarchy }}
 */
async function fetchMeterDetail(meterId) {
  const response = await session.portalGet(`/meters/${meterId}/__data.json`);

  if (response.status === 404) {
    const err = new Error(`Meter not found: ${meterId}`);
    err.statusCode = 404;
    throw err;
  }
  if (response.status !== 200) {
    const err = new Error(`Portal meter detail failed with status ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  // The meter data is in nodes[2] (index 0=null/skip, 1=user, 2=meter data)
  const nodes = response.data && response.data.nodes;
  if (nodes && nodes[2] && (nodes[2].type === 'error' || nodes[2].status === 404)) {
    const err = new Error(`Meter not found: ${meterId}`);
    err.statusCode = 404;
    throw err;
  }
  if (!nodes || nodes.length < 3 || !nodes[2] || !nodes[2].data) {
    const err = new Error(`Unexpected __data.json structure for meter ${meterId}`);
    err.statusCode = 502;
    throw err;
  }

  const resolved = resolveSkNode(nodes[2].data);
  // resolved = { meterId, detail: { data: [...params] }, hierarchy: {...} }

  const detail = resolved.detail || {};
  const detailParams = detail.data || [];
  const hierarchy = resolved.hierarchy || {};

  // Build a clean nameplate object from the parameter array
  const nameplate = {};
  for (const param of detailParams) {
    if (param && param.parameterName && param.parameterValue !== undefined) {
      nameplate[param.parameterName] = param.parameterValue;
    }
  }

  return {
    meterId: resolved.meterId,
    serialNo: nameplate['Serial No'] || null,
    make: nameplate['Make'] || null,
    phaseType: nameplate['Phase Type'] || null,
    installStatus: nameplate['Installation Status'] || null,
    installType: nameplate['Installation Type'] || null,
    hierarchy: {
      zone: hierarchy['Zone'] || null,
      circle: hierarchy['Circle'] || null,
      division: hierarchy['Division'] || null,
      subdivision: hierarchy['Subdivision'] || null,
      subStation: hierarchy['Sub Station'] || null,
      feeder: hierarchy['Feeder'] || null,
      dt: hierarchy['DT'] || null,
    },
  };
}

/**
 * Fetch meter geo-coordinates from /portal/meters/{id}/geo.
 *
 * @param {string} meterId
 * @returns {{ latitude: string, longitude: string } | null}
 */
async function fetchMeterGeo(meterId) {
  const response = await session.portalGet(`/portal/meters/${meterId}/geo`);

  if (response.status === 404) return null;
  if (response.status !== 200) {
    const err = new Error(`Portal geo endpoint failed with status ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  return response.data && response.data.data ? response.data.data : null;
}

/**
 * Fetch all consumption readings from /portal/meters/{id}/energy.
 * Values arrive as strings from the portal — normalized here to numbers.
 *
 * Note: kWh and kVAh are CUMULATIVE meter readings, not interval deltas.
 *
 * @param {string} meterId
 * @returns {Array<{ timestamp: string, kwh: number, kvah: number, voltR: number }>}
 */
async function fetchMeterEnergy(meterId) {
  const response = await session.portalGet(`/portal/meters/${meterId}/energy`);

  if (response.status === 404) {
    const err = new Error(`Meter not found: ${meterId}`);
    err.statusCode = 404;
    throw err;
  }
  if (response.status !== 200) {
    const err = new Error(`Portal energy endpoint failed with status ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  const rawReadings = (response.data && response.data.data) || [];

  return rawReadings.map(r => ({
    timestamp: r.timestamp,           // keep original DD/MM/YYYY HH:mm string
    kwh: parseFloat(r.kwh),           // cumulative kWh reading
    kvah: parseFloat(r.kvah),         // cumulative kVAh reading
    voltR: parseInt(r.voltR, 10),     // R-phase voltage in Volts
  }));
}

/**
 * Fetch the transformer/DT listing.
 *
 * @param {number} page - Page number (1-indexed)
 * @returns {{ data: object[], total: number, page: number, pageSize: number }}
 */
async function fetchTransformerList(page = 1) {
  const params = new URLSearchParams({ page: String(page) });
  const response = await session.portalGet(`/portal/dts?${params}`);

  if (response.status !== 200) {
    const err = new Error(`Portal DT listing failed with status ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  return response.data;
}

module.exports = {
  fetchMeterList,
  fetchMeterDetail,
  fetchMeterGeo,
  fetchMeterEnergy,
  fetchTransformerList,
  resolveSkNode, // exported for unit testing
};
