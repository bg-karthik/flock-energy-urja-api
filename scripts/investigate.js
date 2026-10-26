/**
 * scripts/investigate.js
 *
 * Playwright-based network investigation for Urja Meter Ops portal.
 * Captures login request structure, meter listing API, meter detail,
 * and consumption data sources.
 *
 * Run: node scripts/investigate.js
 * Credentials must be set in scripts/.env.investigation (never committed).
 *
 * Output: scripts/evidence/findings.json (sanitized — no secrets)
 */

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load credentials from a gitignored local env file
const envPath = path.join(__dirname, '.env.investigation');
if (!fs.existsSync(envPath)) {
  console.error('\n[ERROR] Missing scripts/.env.investigation');
  console.error('Create it with:\n  URJA_USERNAME=your_email\n  URJA_PASSWORD=your_password\n');
  process.exit(1);
}
dotenv.config({ path: envPath });

const BASE_URL = 'https://urja-ops.flockenergy.tech';
const USERNAME = process.env.URJA_USERNAME;
const PASSWORD = process.env.URJA_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('[ERROR] URJA_USERNAME and URJA_PASSWORD must be set in scripts/.env.investigation');
  process.exit(1);
}

const EVIDENCE_DIR = path.join(__dirname, 'evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// ------------------------------------------------------------------
// Sanitization helpers — never log credential or secret values
// ------------------------------------------------------------------

const SENSITIVE_FIELDS = ['password', 'token', 'csrf', 'secret', 'authorization', 'cookie', 'set-cookie'];

function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lk = key.toLowerCase();
    if (SENSITIVE_FIELDS.some(f => lk.includes(f))) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeCookies(setCookieHeader) {
  if (!setCookieHeader) return [];
  const lines = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return lines.map(line => {
    // Extract name only (before =), flags only — never value
    const parts = line.split(';').map(p => p.trim());
    const nameOnly = parts[0].split('=')[0].trim();
    const flags = parts.slice(1);
    return { name: nameOnly, flags };
  });
}

function sanitizePostBody(body, fieldsThatAreCredentials = []) {
  if (!body) return null;
  try {
    const params = new URLSearchParams(body);
    const out = {};
    for (const [key] of params.entries()) {
      const lk = key.toLowerCase();
      const isSensitive =
        fieldsThatAreCredentials.includes(lk) ||
        SENSITIVE_FIELDS.some(f => lk.includes(f));
      out[key] = isSensitive ? '[REDACTED]' : params.get(key);
    }
    return out;
  } catch {
    return { raw_length: body.length, note: 'Could not parse as form-urlencoded' };
  }
}

// ------------------------------------------------------------------
// Evidence collector
// ------------------------------------------------------------------

const evidence = {
  capturedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  authentication: {},
  meterListing: {},
  meterDetail: {},
  consumption: {},
  transformers: {},
  allRequests: [],
};

// ------------------------------------------------------------------
// Main investigation
// ------------------------------------------------------------------

async function run() {
  console.log('\n=== Urja Meter Ops — Playwright Investigation ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    // Record all HTTP traffic
    recordHar: { path: path.join(EVIDENCE_DIR, 'session.har'), omitContent: false },
  });
  const page = await context.newPage();

  // ----------------------------------------------------------------
  // Attach request/response listeners before any navigation
  // ----------------------------------------------------------------

  page.on('request', req => {
    const url = req.url();
    if (!url.startsWith(BASE_URL)) return; // ignore CDN/analytics
    const entry = {
      type: 'request',
      method: req.method(),
      url: url.replace(BASE_URL, ''),
      resourceType: req.resourceType(),
      headers: sanitizeHeaders(req.headers()),
    };
    if (req.method() === 'POST') {
      const raw = req.postData() || '';
      entry.postFields = sanitizePostBody(raw, ['password', USERNAME.toLowerCase()]);
      entry.postDataLength = raw.length;
    }
    evidence.allRequests.push(entry);
  });

  page.on('response', async res => {
    const url = res.url();
    if (!url.startsWith(BASE_URL)) return;
    const req = res.request();
    const entry = {
      type: 'response',
      method: req.method(),
      url: url.replace(BASE_URL, ''),
      status: res.status(),
      statusText: res.statusText(),
      headers: sanitizeHeaders(res.headers()),
      cookies: sanitizeCookies(res.headers()['set-cookie']),
    };
    // Capture small JSON/text responses — not binary assets
    const ct = res.headers()['content-type'] || '';
    const isCaptureable =
      (ct.includes('json') || ct.includes('text')) &&
      !url.match(/\.(js|css|woff|png|jpg|svg)(\?|$)/);
    if (isCaptureable) {
      try {
        entry.bodyPreview = (await res.text()).substring(0, 4000);
      } catch {
        entry.bodyPreview = null;
      }
    }
    evidence.allRequests.push(entry);
  });

  // ----------------------------------------------------------------
  // PHASE 1 — Login page inspection
  // ----------------------------------------------------------------

  console.log('[1] Navigating to login page...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });

  // Extract form fields
  const loginForm = await page.evaluate(() => {
    const f = document.querySelector('form');
    if (!f) return { found: false };
    return {
      found: true,
      action: f.action || f.getAttribute('action'),
      method: f.method || f.getAttribute('method'),
      enctype: f.enctype || f.getAttribute('enctype') || 'not-set',
      inputs: Array.from(f.querySelectorAll('input')).map(i => ({
        name: i.name || i.getAttribute('name'),
        type: i.type || i.getAttribute('type'),
        id: i.id,
        placeholder: i.placeholder,
        autocomplete: i.autocomplete,
        hasHiddenValue: i.type === 'hidden' && !!i.value,
        // Never log the value — just confirm if a hidden token exists
      })),
      buttons: Array.from(f.querySelectorAll('button')).map(b => ({
        type: b.type, text: b.innerText.trim(),
        formaction: b.getAttribute('formaction'),
      })),
    };
  });

  evidence.authentication.loginFormStructure = loginForm;
  console.log('[1] Login form captured:', JSON.stringify(loginForm, null, 2));

  // ----------------------------------------------------------------
  // PHASE 2 — Submit login and capture request
  // ----------------------------------------------------------------

  console.log('\n[2] Submitting login form...');

  // Fill form fields by type — supports both name="email" and name="username"
  const emailInput = page.locator('input[type="email"], input[name="email"], input[name="username"]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  await emailInput.fill(USERNAME);
  await passwordInput.fill(PASSWORD);

  // Capture the specific login POST by listening before click
  const loginRequestCapture = {};

  const [loginResponse] = await Promise.all([
    page.waitForResponse(res =>
      res.url().startsWith(BASE_URL) &&
      res.request().method() === 'POST' &&
      (res.url().includes('login') || res.url().endsWith('/?/login') || res.url().endsWith(BASE_URL + '/')),
      { timeout: 15000 }
    ).catch(() => null),
    page.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);

  // Wait for navigation to settle
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  const postLoginUrl = page.url();
  console.log('[2] Post-login URL:', postLoginUrl);

  if (loginResponse) {
    const loginReq = loginResponse.request();
    loginRequestCapture.requestUrl = loginReq.url().replace(BASE_URL, '');
    loginRequestCapture.method = loginReq.method();
    loginRequestCapture.contentType = loginReq.headers()['content-type'] || null;
    loginRequestCapture.postFields = sanitizePostBody(
      loginReq.postData() || '',
      ['password', USERNAME.toLowerCase(), USERNAME.split('@')[0].toLowerCase()]
    );
    loginRequestCapture.responseStatus = loginResponse.status();
    loginRequestCapture.responseContentType = loginResponse.headers()['content-type'] || null;
    loginRequestCapture.setCookies = sanitizeCookies(loginResponse.headers()['set-cookie']);
    loginRequestCapture.redirected = loginResponse.url() !== loginReq.url();
    loginRequestCapture.finalUrl = postLoginUrl.replace(BASE_URL, '');

    try {
      const body = await loginResponse.text();
      loginRequestCapture.responseBodyPreview = body.substring(0, 800);
    } catch {
      loginRequestCapture.responseBodyPreview = null;
    }

    console.log('[2] Login request captured:', JSON.stringify(loginRequestCapture, null, 2));
  } else {
    loginRequestCapture.note = 'waitForResponse did not match — see allRequests for POST entries';
    console.log('[2] Login response not directly captured via waitForResponse — check allRequests');
  }

  evidence.authentication.loginRequest = loginRequestCapture;
  evidence.authentication.landedOnUrl = postLoginUrl.replace(BASE_URL, '');
  evidence.authentication.loginSucceeded = !postLoginUrl.includes('/login');

  // ----------------------------------------------------------------
  // PHASE 3 — Meter listing
  // ----------------------------------------------------------------

  if (evidence.authentication.loginSucceeded) {
    console.log('\n[3] Navigating to meter listing...');
    await page.goto(`${BASE_URL}/meters`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const meterPage = await page.evaluate(() => {
      const table = document.querySelector('table');
      const total = document.body.innerText.match(/(\d+)\s+total/i);
      return {
        url: window.location.href,
        pageTitle: document.title,
        totalText: total ? total[0] : null,
        tableHeaders: table
          ? Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim())
          : [],
        firstFiveRows: table
          ? Array.from(table.querySelectorAll('tbody tr')).slice(0, 5).map(r =>
              Array.from(r.querySelectorAll('td')).map(td => ({
                text: td.innerText.trim(),
                href: td.querySelector('a') ? td.querySelector('a').getAttribute('href') : null,
              }))
            )
          : [],
        searchInput: (() => {
          const el = document.querySelector('input[type="search"], input[placeholder*="search" i], input[placeholder*="meter" i]');
          return el ? { name: el.name, placeholder: el.placeholder, type: el.type } : null;
        })(),
        pagination: Array.from(document.querySelectorAll('[aria-label*="page"], .pagination, nav a')).map(el => ({
          text: el.innerText.trim(),
          href: el.getAttribute('href'),
        })).filter(el => el.text),
      };
    });

    evidence.meterListing.pageInfo = meterPage;
    console.log('[3] Meter listing captured:', JSON.stringify(meterPage, null, 2));

    // Probe the __data.json endpoint for meters
    console.log('[3] Probing /meters/__data.json...');
    const dataJsonResponse = await page.evaluate(async () => {
      const r = await fetch('/meters/__data.json', { credentials: 'include' });
      const body = await r.text();
      return {
        url: '/meters/__data.json',
        status: r.status,
        contentType: r.headers.get('content-type'),
        bodyLength: body.length,
        bodyPreview: body.substring(0, 4000),
      };
    });
    evidence.meterListing.dataJsonProbe = dataJsonResponse;
    console.log('[3] /meters/__data.json status:', dataJsonResponse.status, dataJsonResponse.contentType);

    // Probe with page param
    const dataJsonPage1 = await page.evaluate(async () => {
      const r = await fetch('/meters/__data.json?q=&page=1', { credentials: 'include' });
      const body = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type'), bodyLength: body.length, bodyPreview: body.substring(0, 4000) };
    });
    evidence.meterListing.dataJsonPage1Probe = dataJsonPage1;

    // ----------------------------------------------------------------
    // PHASE 4 — Meter detail J100001
    // ----------------------------------------------------------------

    console.log('\n[4] Navigating to meter J100001 detail...');
    await page.goto(`${BASE_URL}/meters/J100001`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const detailPage = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      return {
        url: window.location.href,
        pageTitle: document.title,
        headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(h => h.innerText.trim()),
        breadcrumb: document.querySelector('nav, [aria-label*="breadcrumb"]')?.innerText?.trim() || null,
        allBodyText: document.body.innerText.substring(0, 3000),
        tables: tables.map((t, i) => ({
          index: i,
          headers: Array.from(t.querySelectorAll('th')).map(th => th.innerText.trim()),
          rowCount: t.querySelectorAll('tbody tr').length,
          firstTenRows: Array.from(t.querySelectorAll('tbody tr')).slice(0, 10).map(r =>
            Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim())
          ),
        })),
      };
    });

    evidence.meterDetail.pageInfo = detailPage;
    console.log('[4] Detail page heading:', detailPage.headings[0]);

    // Probe __data.json for meter detail
    const detailDataJson = await page.evaluate(async () => {
      const r = await fetch('/meters/J100001/__data.json', { credentials: 'include' });
      const body = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type'), bodyLength: body.length, body: body };
    });
    evidence.meterDetail.dataJson = detailDataJson;
    console.log('[4] /meters/J100001/__data.json status:', detailDataJson.status);

    // ----------------------------------------------------------------
    // PHASE 5 — Consumption endpoint discovery
    // ----------------------------------------------------------------

    console.log('\n[5] Probing consumption endpoints...');
    const consumptionProbes = await page.evaluate(async () => {
      const urls = [
        '/meters/J100001/consumption',
        '/meters/J100001/consumption/__data.json',
        '/meters/J100001/consumption?page=1',
        '/meters/J100001/readings',
        '/api/meters/J100001/consumption',
      ];
      const results = [];
      for (const url of urls) {
        const r = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json,text/html,*/*' },
        });
        const body = await r.text();
        results.push({
          url,
          status: r.status,
          contentType: r.headers.get('content-type'),
          bodyLength: body.length,
          bodyPreview: body.substring(0, 600),
        });
      }
      return results;
    });
    evidence.consumption.probes = consumptionProbes;
    consumptionProbes.forEach(p => console.log(`[5] ${p.url} → ${p.status} ${p.contentType || ''}`));

    // ----------------------------------------------------------------
    // PHASE 6 — Transformers
    // ----------------------------------------------------------------

    console.log('\n[6] Navigating to /transformers...');
    await page.goto(`${BASE_URL}/transformers`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const transformersPage = await page.evaluate(() => {
      const table = document.querySelector('table');
      return {
        url: window.location.href,
        pageTitle: document.title,
        headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => h.innerText.trim()),
        totalText: document.body.innerText.match(/(\d+)\s+total/i)?.[0] || null,
        tableHeaders: table ? Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim()) : [],
        firstThreeRows: table
          ? Array.from(table.querySelectorAll('tbody tr')).slice(0, 3).map(r =>
              Array.from(r.querySelectorAll('td')).map(td => ({
                text: td.innerText.trim(),
                href: td.querySelector('a') ? td.querySelector('a').getAttribute('href') : null,
              }))
            )
          : [],
      };
    });
    evidence.transformers.pageInfo = transformersPage;
    console.log('[6] Transformers captured:', JSON.stringify(transformersPage, null, 2));

    // Probe transformer detail
    if (transformersPage.firstThreeRows.length > 0) {
      const firstHref = transformersPage.firstThreeRows[0].find(c => c.href)?.href;
      if (firstHref) {
        const dtId = firstHref.split('/').pop();
        await page.goto(`${BASE_URL}/transformers/${dtId}/__data.json`, { waitUntil: 'networkidle' }).catch(() => {});
        const dtDataJson = await page.evaluate(async (id) => {
          const r = await fetch(`/transformers/${id}/__data.json`, { credentials: 'include' });
          const body = await r.text();
          return { status: r.status, contentType: r.headers.get('content-type'), bodyPreview: body.substring(0, 3000) };
        }, dtId);
        evidence.transformers.dataJson = { dtId, ...dtDataJson };
        console.log(`[6] /transformers/${dtId}/__data.json status:`, dtDataJson.status);
      }
    }

  } else {
    console.log('[!] Login did not succeed — skipping authenticated phases');
    evidence.authentication.error = 'Login failed or redirected back to login page';
  }

  // ----------------------------------------------------------------
  // Save evidence
  // ----------------------------------------------------------------

  await context.close();
  await browser.close();

  // Strip any accidental credential leaks from allRequests
  evidence.allRequests = evidence.allRequests
    .filter(r => r.resourceType !== 'stylesheet' && r.resourceType !== 'font' && r.resourceType !== 'image')
    .map(r => {
      if (r.postFields) {
        for (const key of Object.keys(r.postFields)) {
          const lk = key.toLowerCase();
          if (SENSITIVE_FIELDS.some(f => lk.includes(f)) || lk === 'password') {
            r.postFields[key] = '[REDACTED]';
          }
        }
      }
      return r;
    });

  const outputPath = path.join(EVIDENCE_DIR, 'findings.json');
  fs.writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
  console.log(`\n✅ Evidence saved to: ${outputPath}`);
  console.log('\n=== Investigation Complete ===\n');

  // Print summary to console
  console.log('--- AUTHENTICATION SUMMARY ---');
  console.log('Login form found:', evidence.authentication.loginFormStructure?.found);
  console.log('Input field names:', evidence.authentication.loginFormStructure?.inputs?.map(i => i.name));
  console.log('Login POST captured:', !!evidence.authentication.loginRequest?.requestUrl);
  console.log('Login POST URL:', evidence.authentication.loginRequest?.requestUrl || 'not captured');
  console.log('Login POST Content-Type:', evidence.authentication.loginRequest?.contentType);
  console.log('Login response status:', evidence.authentication.loginRequest?.responseStatus);
  console.log('Session cookies set:', evidence.authentication.loginRequest?.setCookies?.map(c => c.name));
  console.log('Login succeeded:', evidence.authentication.loginSucceeded);
  console.log('Landed on:', evidence.authentication.landedOnUrl);

  console.log('\n--- METER LISTING SUMMARY ---');
  console.log('Table headers:', evidence.meterListing.pageInfo?.tableHeaders);
  console.log('/meters/__data.json status:', evidence.meterListing.dataJsonProbe?.status);

  console.log('\n--- CONSUMPTION ENDPOINT SUMMARY ---');
  (evidence.consumption.probes || []).forEach(p =>
    console.log(`  ${p.url} → HTTP ${p.status}`)
  );
}

run().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
