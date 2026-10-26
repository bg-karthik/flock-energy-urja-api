# Urja Meter Ops  -  REST API Wrapper

A robust Node.js and Express REST API wrapper around the **Urja Meter Ops** legacy portal (`https://urja-ops.flockenergy.tech`).

This service provides clean, structured, JSON-based REST endpoints for smart meter metadata, location hierarchy, and interval consumption data. It eliminates manual portal browsing and screen scraping for downstream systems by handling session authentication, cookie persistence, and legacy data normalization server-side.

---

## Table of Contents

- [Why This Wrapper Is Needed](#why-this-wrapper-is-needed)
- [Features Implemented](#features-implemented)
- [Technology Stack](#technology-stack)
- [Architecture & Project Structure](#architecture--project-structure)
- [Setup Instructions](#setup-instructions)
- [Environment Configuration](#environment-configuration)
- [Running the Application](#running-the-application)
- [API Endpoints & Examples](#api-endpoints--examples)
- [Error Handling](#error-handling)
- [Testing Instructions](#testing-instructions)
- [Design Decisions & Trade-Offs](#design-decisions--trade-offs)
- [Assumptions](#assumptions)
- [Known Limitations](#known-limitations)
- [Features Intentionally Skipped](#features-intentionally-skipped)
- [Future Improvements](#future-improvements)
- [Documentation References](#documentation-references)

---

## Why This Wrapper Is Needed

The Urja Meter Ops legacy portal was designed as an internal operator UI built on SvelteKit rather than an open machine-to-machine API:

1. **Session & Form Complications:** Authentication uses SvelteKit enhanced form actions requiring specific headers (`x-sveltekit-action: true`, `Origin`, and `Referer`) rather than standard OAuth or basic API tokens.
2. **Session Cookies:** The authenticated session uses an HttpOnly `__Secure-better-auth.session_token` cookie that requires cookie-jar lifecycle management.
3. **Data Dispersal:** Viewing complete meter information requires reconciling disparate data sources  -  an internal search endpoint (`/portal/meters/search`), an indexed-reference SvelteKit payload (`/meters/{id}/__data.json`), GPS coordinates (`/portal/meters/{id}/geo`), and energy history (`/portal/meters/{id}/energy`).
4. **Data Inconsistencies:** Coordinates and cumulative energy readings arrive as strings and must be parsed and validated into structured numerical types.

This API acts as an adapter layer that abstracts away the legacy quirks, manages authentication behind the scenes, and provides a consistent REST interface.

---

## Features Implemented

- **Automated Server-Side Authentication:** Securely authenticates against the legacy portal using SvelteKit form action protocols without exposing credentials or cookies to end users.
- **Session Persistence & Auto-Reauthentication:** Uses an in-memory cookie jar (`tough-cookie` + `axios-cookiejar-support`). Automatically detects session expiration (via login redirects or HTML markers) and reauthenticates with at most one retry.
- **Core REST Endpoints:**
  - `GET /api/v1/meters`  -  Paginated meter catalog with optional query search (`q`).
  - `GET /api/v1/meters/:id`  -  Unified meter detail combining nameplate attributes, GPS coordinates, and electrical distribution hierarchy.
  - `GET /api/v1/meters/:id/consumption`  -  Historical 30-minute interval readings (cumulative kWh/kVAh and R-phase voltage).
  - `GET /health`  -  Simple service health check.
- **Data Normalization:**
  - SvelteKit indexed-array graph parser to extract nameplate and hierarchy fields from `__data.json`.
  - Type-safe parsing: string coordinates to floats, cumulative energy readings to numbers, voltage to integers.
- **Interactive Documentation:** Interactive OpenAPI 3.0 / Swagger UI documentation served at `/docs`.
- **Automated Testing:** 35 unit and integration tests across route validation, error handling, session management, and data normalization.

---

## Technology Stack

- **Runtime:** Node.js 24
- **Web Framework:** Express.js 5
- **HTTP Client:** Axios 1.x
- **Cookie Jar:** `tough-cookie` 4.x + `axios-cookiejar-support` 4.x
- **Configuration:** `dotenv`
- **API Documentation:** OpenAPI 3.0.3, `swagger-ui-express`
- **Testing:** Jest 30, Supertest 7
- **Browser Automation (Investigation Phase):** Playwright

---

## Architecture & Project Structure

The project follows a clean separation of concerns:

```
├── .env.example              # Environment variables template
├── .gitignore                # Git ignore rules (protects credentials & logs)
├── openapi.json              # OpenAPI 3.0.3 specification
├── package.json              # Dependencies and run scripts
├── PROTOCOL.md               # Reverse-engineering findings & verified protocol
├── README.md                 # Project documentation
├── REFLECTION.md             # Implementation reflection & interview notes
├── scripts/
│   ├── .env.investigation.example  # Example credentials for investigation
│   └── investigate.js        # Playwright browser inspection script
├── src/
│   ├── app.js                # Express app setup (routes, middleware, Swagger UI)
│   ├── config.js             # Configuration loading & validation
│   ├── server.js             # Server startup entry point
│   ├── session.js            # Axios client, cookie jar & session lifecycle
│   ├── middleware/
│   │   └── errorHandler.js   # Centralized error handler
│   ├── routes/
│   │   └── meters.js         # REST route handlers & query validation
│   └── services/
│       └── portalClient.js   # Upstream portal adapter & data parsers
└── tests/
    ├── meters.test.js        # API route integration tests (mocked portal)
    └── session.test.js       # Session manager, auth & re-auth unit tests
```

---

## Setup Instructions

### Prerequisites
- Node.js >= 20 (Node.js 24 recommended)
- npm >= 10

### 1. Clone & Install
```bash
git clone https://github.com/bg-karthik/flock-energy-urja-api.git
cd flock-energy-urja-api
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and supply your Urja portal credentials:
```bash
cp .env.example .env
```
Edit `.env`:
```env
PORTAL_USERNAME=operator@urja.local
PORTAL_PASSWORD=your-portal-password
PORTAL_BASE_URL=https://urja-ops.flockenergy.tech
PORT=3000
PORTAL_TIMEOUT_MS=10000
NODE_ENV=development
```

---

## Running the Application

### Start in Production Mode
```bash
npm start
```

### Start in Development Mode (Live Reload)
```bash
npm run dev
```

The server starts on `http://localhost:3000`.
- Swagger UI Documentation: `http://localhost:3000/docs`
- Health Check: `http://localhost:3000/health`

---

## API Endpoints & Examples

### 1. List Meters
`GET /api/v1/meters?q={query}&page={page}`

Returns a paginated list of meters (20 per page).

**Example Request:**
```bash
curl http://localhost:3000/api/v1/meters?page=1
```

**Example Response (200 OK):**
```json
{
  "data": [
    {
      "meterId": "J100000",
      "serialNo": "SE33962",
      "make": "HPL",
      "phaseType": "single",
      "installStatus": "Decommissioned",
      "dtCode": "DT-001"
    },
    {
      "meterId": "J100001",
      "serialNo": "GE84132",
      "make": "L&T",
      "phaseType": "single",
      "installStatus": "Installed",
      "dtCode": "DT-002"
    }
  ],
  "pagination": {
    "total": 403,
    "page": 1,
    "pageSize": 20,
    "totalPages": 21
  }
}
```

---

### 2. Get Meter Detail
`GET /api/v1/meters/:id`

Returns combined nameplate metadata, GPS coordinates, and 7-tier distribution hierarchy.

**Example Request:**
```bash
curl http://localhost:3000/api/v1/meters/J100001
```

**Example Response (200 OK):**
```json
{
  "meterId": "J100001",
  "serialNo": "GE84132",
  "make": "L&T",
  "phaseType": "single",
  "installStatus": "Installed",
  "installType": "CT Operated",
  "location": {
    "latitude": 26.822136543835608,
    "longitude": 75.90718190602279
  },
  "hierarchy": {
    "zone": "Jaipur Zone 2 (Z-02)",
    "circle": "Circle 2 (C-02)",
    "division": "Division 2 (D-02)",
    "subdivision": "Subdivision 2 (SD-02)",
    "subStation": "Substation 2 (SS-02)",
    "feeder": "Feeder 2 (F-002)",
    "dt": "Mansarovar DT 2 (DT-002)"
  }
}
```

---

### 3. Get Consumption History
`GET /api/v1/meters/:id/consumption`

Returns all available 30-minute interval readings for a meter.

> **Data Notice:** `kwh` and `kvah` are **cumulative meter readings** (like an odometer), not delta consumption during that interval. To compute interval usage, calculate the difference between consecutive timestamps.

**Example Request:**
```bash
curl http://localhost:3000/api/v1/meters/J100001/consumption
```

**Example Response (200 OK):**
```json
{
  "meterId": "J100001",
  "note": "kWh and kVAh are cumulative meter readings, not interval deltas. Interval: 30 minutes.",
  "count": 337,
  "data": [
    {
      "timestamp": "23/06/2026 23:30",
      "kwh": 42594.05,
      "kvah": 46001.58,
      "voltR": 231
    },
    {
      "timestamp": "24/06/2026 00:00",
      "kwh": 42594.47,
      "kvah": 46002.02,
      "voltR": 230
    }
  ]
}
```

---

## Error Handling

Standardized JSON error responses are returned for all client and upstream failures:

```json
{
  "error": {
    "status": 400,
    "message": "Invalid meter ID format: \"MTR123\". Expected format: J followed by 6 digits (e.g. J100001)."
  }
}
```

| HTTP Status | Meaning | Scenario |
|---|---|---|
| `400 Bad Request` | Client validation failure | Non-integer `page`, invalid meter ID regex (`^J\d{6}$`) |
| `404 Not Found` | Resource not found | Meter ID does not exist on legacy portal |
| `502 Bad Gateway` | Upstream failure | Legacy portal is offline, returned non-200, or timed out |
| `500 Internal Error` | Unexpected server error | Uncaught internal runtime exceptions |

---

## Testing Instructions

The automated test suite uses **Jest** and **Supertest**. Tests run completely in isolation using mocked portal responses (no live network dependencies required).

### Run Test Suite
```bash
npm test
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```

### Test Coverage Highlights (35 passing tests):
1. **Authentication Flow:** Successful POST `/login` with SvelteKit action headers; error handling on invalid credentials.
2. **Session Lifecycle:** Detection of expired session via redirect headers or HTML markers; automatic re-authentication; at most 1 retry guard against infinite loops.
3. **Meter Catalog:** Listing pagination (`total`, `page`, `pageSize`, `totalPages`), query parameter filtering, page validation (`page < 1`, non-integer).
4. **Meter Details:** Merging nameplate and geo responses, handling meters with missing GPS (`location: null`), 400 for malformed IDs, 404 for non-existent meters.
5. **Consumption Readings:** Cumulative reading note inclusion, parsing string floats to numbers, upstream error handling.
6. **Data Normalization:** Verification of SvelteKit indexed array node deserialization (`resolveSkNode`).

---

## Design Decisions & Trade-Offs

1. **CommonJS Module System:**
   - *Decision:* Used standard CommonJS (`require` / `module.exports`) with `axios-cookiejar-support@4`.
   - *Trade-off:* Avoids ESM/Jest module transformation friction while retaining native compatibility with Node.js 24 and Supertest.
2. **Direct JSON API Usage over Cheerio HTML Scraping:**
   - *Decision:* Investigated the browser network traffic with Playwright and discovered internal JSON routes (`/portal/meters/search`, `/portal/meters/{id}/geo`, `/portal/meters/{id}/energy`).
   - *Trade-off:* Relying on the JSON endpoints is faster, consumes less bandwidth, and is much less fragile than scraping DOM classes with Cheerio.
3. **Custom SvelteKit Indexed Node Resolver:**
   - *Decision:* Wrote a recursive graph resolver (`resolveSkNode`) to unpack SvelteKit's serialized `__data.json` format for meter nameplates and hierarchy.
   - *Trade-off:* Requires handling pointer indices (`[{meterId: 1}, "J100001"]`), but eliminates the need to load heavy full HTML pages.
4. **Server-Managed Session vs. User-Facing Login:**
   - *Decision:* Authentication is managed entirely server-side with service credentials from `.env`.
   - *Trade-off:* End consumers of the REST API do not need to authenticate with Urja portal credentials, simplifying integration for internal automated microservices.

---

## Assumptions

- **Meter ID Format:** All valid meter IDs consist of the letter `J` followed by exactly 6 digits (e.g., `J100000` to `J100402`), based on the verified 403 total meters.
- **Fixed Page Size:** The legacy portal fixes the page size at 20 records; the API reflects this in its pagination metadata.
- **Reading Semantics:** `kwh` and `kvah` are cumulative register readings; the API explicitly alerts consumers not to mistake them for period deltas.
- **Single-Tenant Operator Account:** A single operator credential is used to query the portal on behalf of the API wrapper.

---

## Known Limitations

- **Rate Limits & Concurrency:** The legacy portal has not been load-tested under high concurrent request volume.
- **No Date Range Filtering for Consumption:** The portal's `/portal/meters/{id}/energy` endpoint returns all available historical intervals without date filter parameters. Date filtering must currently be done client-side.
- **In-Memory Cookie Jar:** The cookie jar lives in Node.js process memory. Restarting the server reauthenticates on the next incoming request.

---

## Features Intentionally Skipped

- **Database / Cache Layer:** Kept deliberately stateless and lean without Redis or SQLite, adhering to junior-scoped requirements and avoiding cache invalidation complexity.
- **Frontend Dashboard:** A web UI was out of scope; focus was placed on API reliability, data normalization, and complete documentation.
- **Transformer Endpoints:** While `/portal/dts` was investigated and verified in `PROTOCOL.md`, it was not part of the core 3 requested meter endpoints.

---

## Future Improvements

1. **In-Memory TTL Cache:** Cache static meter nameplate and hierarchy responses (which rarely change) for 5-15 minutes to reduce upstream load.
2. **Client-Side Energy Filtering:** Add optional `startDate` and `endDate` query parameters to `GET /api/v1/meters/:id/consumption` to filter the returned interval array in memory.
3. **Rate Limiting Middleware:** Protect the API wrapper with `express-rate-limit` to prevent downstream callers from overwhelming the legacy portal.
4. **Interval Delta Calculations:** Provide an optional query param `?deltas=true` to compute consumption differences between successive timestamps automatically.

---

## Documentation References

- **Protocol Findings:** See [PROTOCOL.md](PROTOCOL.md) for full reverse-engineering notes, captured payloads, and SvelteKit action details.
- **OpenAPI 3.0 Specification:** See [openapi.json](openapi.json) or visit `http://localhost:3000/docs`.
- **Engineering Reflection:** See [REFLECTION.md](REFLECTION.md) for reflections on assumptions, debugging challenges, mistakes made, and self-review criticisms.
