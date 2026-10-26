# PROTOCOL.md — Urja Meter Ops Legacy Portal

> This document records findings about the Urja Meter Ops legacy portal.
> All findings are based on direct automated Playwright network inspection
> conducted on 2026-10-26 using `scripts/investigate.js`.
> Each finding is classified as **Verified**, **Inferred**, or **Not yet verified**.

---

## 1. Portal Overview

| Property | Value | Status |
|---|---|---|
| Base URL | `https://urja-ops.flockenergy.tech` | ✅ Verified |
| Framework | SvelteKit (SSR + client-side hydration) | ✅ Verified — `x-sveltekit-page: true` response header observed |
| Navigation sections | Meters, Transformers | ✅ Verified — confirmed in page DOM |
| User display name | "Ops Desk" | ✅ Verified — from `__data.json` user node |
| Authenticated user field | `name`, `email` | ✅ Verified — from `__data.json` |

---

## 2. Authentication

### 2.1 Login Form Structure

Observed directly from `/login` page DOM via Playwright.

| Property | Observed Value | Status |
|---|---|---|
| Login page URL | `/login` | ✅ Verified |
| Form `action` attribute | `https://urja-ops.flockenergy.tech/login` | ✅ Verified |
| Form `method` attribute | `post` | ✅ Verified |
| Form `enctype` attribute | `application/x-www-form-urlencoded` | ✅ Verified |
| Input field 1 | `name="email"`, `type="email"`, `autocomplete="username"` | ✅ Verified |
| Input field 2 | `name="password"`, `type="password"`, `autocomplete="current-password"` | ✅ Verified |
| Hidden / CSRF token field | None present | ✅ Verified — `hasHiddenValue: false` for all inputs |
| Submit button | `type="submit"`, text "Sign in" | ✅ Verified |

### 2.2 Login Request (Enhanced SvelteKit Form Submission)

> **Key finding:** The portal uses **SvelteKit enhanced form submission** (`use:enhance`),
> NOT a plain HTML POST with a 303 redirect. When JavaScript is active, SvelteKit intercepts
> the form submit and sends the credentials as a `fetch()` call with the header
> `x-sveltekit-action: true`. The server responds **HTTP 200** with a JSON body encoding the
> redirect instruction — the browser never receives an actual 303.

| Property | Observed Value | Status |
|---|---|---|
| POST URL | `POST /login` | ✅ Verified |
| Request Content-Type | `application/x-www-form-urlencoded` | ✅ Verified |
| Special header sent | `x-sveltekit-action: true` | ✅ Verified — seen in request headers |
| `Accept` header sent | `application/json` | ✅ Verified |
| `Origin` header sent | `https://urja-ops.flockenergy.tech` | ✅ Verified — required by SvelteKit CSRF action check |
| `Referer` header sent | `https://urja-ops.flockenergy.tech/login` | ✅ Verified |
| Payload field names | `email`, `password` | ✅ Verified |
| Response HTTP status | **200 OK** (not 303) | ✅ Verified |
| Response Content-Type | `application/json` | ✅ Verified |
| Response body on success | `{"type":"redirect","status":303,"location":"/meters"}` | ✅ Verified |
| Set-Cookie in response headers | `__Secure-better-auth.session_token` | ✅ Verified in HAR log and live checks |
| Final landing page | `/meters` | ✅ Verified |

> **Implementation consequence for Axios:** When posting via Axios (not a browser), you MUST
> include the header `x-sveltekit-action: true`, `Accept: application/json`, and `Origin`/`Referer`
> headers matching the host (to satisfy SvelteKit's action CSRF protection).
> Parse the JSON response body; if `type === "redirect"`, follow `location` with a GET
> to complete the authentication. Do NOT expect a 303 from `/login` itself.

### 2.3 Session Cookies

| Property | Observed Value | Status |
|---|---|---|
| Cookie name(s) | `__Secure-better-auth.session_token` | ✅ Verified (captured in HAR and live test) |
| Cookie flags | `Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax` | ✅ Verified |
| Cookie transport | Requires HTTPS due to `__Secure-` prefix | ✅ Verified |
| Session persistence | Maintained across all subsequent requests | ✅ Verified — all protected endpoints returned 200 |

> **Implementation consequence:** Use `axios-cookiejar-support` + `tough-cookie`. The cookie
> jar will automatically capture and replay `__Secure-better-auth.session_token`. Because of the
> `__Secure-` cookie name prefix (RFC 6265bis), requests must be made over HTTPS.

### 2.4 Session Expiry Behaviour

| Property | Observed Value | Status |
|---|---|---|
| Unauthenticated page access | Redirects to `/login` | ✅ Verified — confirmed during browser subagent tests |
| Detection method | Check response URL or login-page marker in HTML body | ✅ Verified |

> **Implementation note:** An expired session returns HTTP 200 with login page HTML (SvelteKit SSR).
> Detect by checking if the final response URL is `/login` or if the body contains a login form.

---

## 3. Meter Listing

### 3.1 The Real Data API

> **Key finding:** The SvelteKit `/meters` page loads its data by calling a **hidden internal
> JSON API** at `/portal/meters/search`. This is NOT the same as the SvelteKit
> `__data.json` endpoint (which returns only session/user data for the layout node, not meter
> records). The `/portal/*` routes are the actual data backend.

| Property | Observed Value | Status |
|---|---|---|
| Data API URL | `GET /portal/meters/search` | ✅ Verified — captured in network traffic |
| Query parameters | `?q=&page=1` | ✅ Verified |
| HTTP Method | `GET` | ✅ Verified |
| Response Content-Type | `application/json` | ✅ Verified |
| Response shape | `{"data": [...], "total": 403, "page": 1, "pageSize": 20}` | ✅ Verified |
| Records per page | 20 | ✅ Verified |
| Total meter records | 403 | ✅ Verified |

### 3.2 Meter Listing Response — JSON Field Names

Observed from `/portal/meters/search?q=&page=1` response body:

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
  "total": 403,
  "page": 1,
  "pageSize": 20
}
```

| JSON Field | Type | Example | Notes |
|---|---|---|---|
| `meterId` | string | `"J100001"` | Primary identifier — always a string |
| `serialNo` | string | `"GE84132"` | Alphanumeric, varies in format |
| `make` | string | `"L&T"`, `"HPL"`, `"Genus"`, `"Allied"`, `"Secure"` | Manufacturer |
| `phaseType` | string | `"single"`, `"three"` | Enum-like |
| `installStatus` | string | `"Installed"`, `"Decommissioned"`, `"Faulty"` | Enum-like |
| `dtCode` | string | `"DT-002"` | Links meter to transformer |
| `total` | number | `403` | Total record count |
| `page` | number | `1` | Current page (1-indexed) |
| `pageSize` | number | `20` | Fixed at 20 |

### 3.3 Search Parameter

| Parameter | Behaviour | Status |
|---|---|---|
| `q` | Search string — matches meter number or serial | ✅ Verified (placeholder text: "Search by meter number or serial…") |
| `page` | Page number (1-indexed) | ✅ Verified |

### 3.4 What `/meters/__data.json` Actually Returns

`GET /meters/__data.json` returns **only session/user data** — not meter records:

```json
{
  "type": "data",
  "nodes": [
    null,
    {"type": "data", "data": [{"user": 1}, {"name": 2, "email": 3}, "Ops Desk", "operator@urja.local"], "uses": {}},
    null
  ]
}
```

> **Conclusion:** Do NOT use `/meters/__data.json` for meter records.
> Use `GET /portal/meters/search?q=&page=N` directly.

---

## 4. Meter Detail

### 4.1 Request Options

Two ways to get meter detail data. Prefer the JSON API.

#### Option A — Direct JSON API (recommended)

| Property | Observed Value | Status |
|---|---|---|
| Geo URL | `GET /portal/meters/{meterId}/geo` | ✅ Verified |
| Energy URL | `GET /portal/meters/{meterId}/energy` | ✅ Verified |
| HTTP Method | `GET` | ✅ Verified |
| Response format | `application/json` | ✅ Verified |

#### Option B — SvelteKit `__data.json` (metadata only, complex format)

| Property | Observed Value | Status |
|---|---|---|
| URL | `GET /meters/{meterId}/__data.json` | ✅ Verified |
| Response format | SvelteKit indexed-reference JSON (requires custom resolver) | ✅ Verified |
| Contains | Nameplate fields + 7-level hierarchy | ✅ Verified |
| Contains consumption | No — consumption comes from `/portal/meters/{id}/energy` | ✅ Verified |

### 4.2 `/portal/meters/{id}/geo` Response

```json
{
  "data": {
    "latitude": "26.822136543835608",
    "longitude": "75.90718190602279"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `data.latitude` | string (decimal) | Geographic latitude |
| `data.longitude` | string (decimal) | Geographic longitude |

### 4.3 `/portal/meters/{id}/energy` Response — Consumption Data

> **Key finding:** Consumption data is served from `GET /portal/meters/{meterId}/energy`.
> There is NO separate `/meters/{id}/consumption` endpoint — that returns 404.

```json
{
  "data": [
    {"timestamp": "23/06/2026 23:30", "kwh": "42594.05", "kvah": "46001.58", "voltR": "231"},
    {"timestamp": "24/06/2026 00:00", "kwh": "42594.47", "kvah": "46002.02", "voltR": "230"},
    ...
  ]
}
```

| JSON Field | Type | Example | Notes |
|---|---|---|---|
| `timestamp` | string | `"23/06/2026 23:30"` | Format: `DD/MM/YYYY HH:mm` |
| `kwh` | string (decimal) | `"42594.05"` | Cumulative meter reading, kWh |
| `kvah` | string (decimal) | `"46001.58"` | Cumulative meter reading, kVAh |
| `voltR` | string (integer) | `"231"` | R-phase voltage in Volts |
| Interval | — | 30 minutes | Every reading is 30 minutes apart |

> **Note:** All numeric values arrive as **strings** in the JSON. Normalize to numbers in the API
> response. KWH and KVAH are **cumulative readings**, not interval deltas.

### 4.4 `__data.json` Nameplate + Hierarchy (for reference)

| Field | Value (J100001) | Status |
|---|---|---|
| Meter ID | J100001 | ✅ Verified |
| Serial No | GE84132 | ✅ Verified |
| Make | L&T | ✅ Verified |
| Phase Type | single | ✅ Verified |
| Installation Status | Installed | ✅ Verified |
| Installation Type | CT Operated | ✅ Verified |
| Zone | Jaipur Zone 2 (Z-02) | ✅ Verified |
| Circle | Circle 2 (C-02) | ✅ Verified |
| Division | Division 2 (D-02) | ✅ Verified |
| Subdivision | Subdivision 2 (SD-02) | ✅ Verified |
| Sub Station | Substation 2 (SS-02) | ✅ Verified |
| Feeder | Feeder 2 (F-002) | ✅ Verified |
| DT | Mansarovar DT 2 (DT-002) | ✅ Verified |

> The `__data.json` format uses SvelteKit's indexed-reference encoding (flat array with
> index-pointer objects). Prefer HTML scraping via Cheerio or the `/portal/meters/{id}/geo`
> + `/portal/meters/{id}/energy` combination for a simpler implementation.

### 4.5 Endpoints Confirmed as 404 (do not implement)

| URL | Status | Note |
|---|---|---|
| `GET /meters/{id}/consumption` | 404 | Does not exist |
| `GET /meters/{id}/consumption/__data.json` | 404 | Does not exist |
| `GET /meters/{id}/readings` | 404 | Does not exist |
| `GET /api/meters/{id}/consumption` | 404 | Does not exist |
| `GET /meters/search?q=&page=1` | 404 | Was never the correct endpoint |

---

## 5. Transformers

### 5.1 Request

| Property | Observed Value | Status |
|---|---|---|
| Data API URL | `GET /portal/dts?page=1` | ✅ Verified — captured in network traffic |
| HTTP Method | `GET` | ✅ Verified |
| Response Content-Type | `application/json` | ✅ Verified |
| Response shape | `{"data": [...], "total": 40, "page": 1, "pageSize": 20}` | ✅ Verified |
| Total DT records | 40 | ✅ Verified |
| Records per page | 20 | ✅ Verified |

### 5.2 Transformer Listing Response — JSON Field Names

```json
{
  "data": [
    {"code": "DT-001", "name": "Malviya Nagar DT 1", "feederCode": "F-001", "capacityKva": 100},
    {"code": "DT-002", "name": "Mansarovar DT 2",    "feederCode": "F-002", "capacityKva": 63},
    {"code": "DT-003", "name": "Vaishali DT 3",      "feederCode": "F-003", "capacityKva": 250}
  ],
  "total": 40,
  "page": 1,
  "pageSize": 20
}
```

| JSON Field | Type | Example | Notes |
|---|---|---|---|
| `code` | string | `"DT-001"` | Transformer identifier — matches `dtCode` in meter listing |
| `name` | string | `"Malviya Nagar DT 1"` | Human-readable name |
| `feederCode` | string | `"F-001"` | Feeder identifier |
| `capacityKva` | number | `100` | Transformer capacity in kVA (integer) |
| `total` | number | `40` | Total record count |
| `page` | number | `1` | Current page (1-indexed) |
| `pageSize` | number | `20` | Fixed at 20 |

---

## 6. Complete Verified Portal API Map

| Method | URL | Auth required | Description |
|---|---|---|---|
| `POST` | `/login` | No | Authenticate. Must send `x-sveltekit-action: true` + `Accept: application/json` |
| `GET` | `/portal/meters/search?q=&page=N` | Yes | Paginated meter listing. `q` for search |
| `GET` | `/portal/meters/{id}/geo` | Yes | Meter lat/lng |
| `GET` | `/portal/meters/{id}/energy` | Yes | Full consumption history (all readings, no pagination observed) |
| `GET` | `/portal/dts?page=N` | Yes | Paginated transformer/DT listing |
| `GET` | `/meters/{id}/__data.json` | Yes | Nameplate + hierarchy (SvelteKit indexed format) |

> **Not yet investigated:** Whether `/portal/meters/search` accepts additional filter parameters
> beyond `q` and `page`. Whether `/portal/meters/{id}/energy` supports date range parameters.
> These can be probed during implementation if needed.

---

## 7. Identifier Formats

| Identifier | Format | Example | Notes |
|---|---|---|---|
| Meter ID | `J` + 6 digits | `J100001` | Always a string — do not cast to integer |
| DT code | `DT-` + 3-digit zero-padded | `DT-001` | Always a string |
| Feeder code | `F-` + 3-digit zero-padded | `F-001` | Always a string |
| Zone code | `Z-` + 2-digit zero-padded | `Z-02` | Embedded in full name string |

---

## 8. Implementation Notes

- **Authentication:** POST to `/login` with `x-sveltekit-action: true` and `Accept: application/json`.
  Parse JSON response; follow `location` field with GET to complete session setup.
  Use `tough-cookie` + `axios-cookiejar-support` to persist the session cookie automatically.

- **Meter listing:** Call `GET /portal/meters/search?q=&page=N`. Page size is fixed at 20.
  Total pages = `Math.ceil(total / pageSize)`.

- **Meter detail:** Combine results from `/portal/meters/{id}/geo` and `/portal/meters/{id}/energy`
  (for consumption). Use `__data.json` for nameplate + hierarchy if needed, but requires custom
  indexed-reference resolver or Cheerio HTML parsing of the `/meters/{id}` page.

- **Consumption:** All readings from `/portal/meters/{id}/energy`. Values arrive as strings —
  parse to floats in the API response. Timestamps are `DD/MM/YYYY HH:mm` — convert to ISO 8601
  in the response if desired.

- **Session expiry:** No explicit expiry signal. If `/portal/*` returns a redirect to `/login`,
  reauthenticate and retry. Detect by checking the response URL or body for login page markers.

- **No CSRF tokens:** The login form has no hidden token fields. Authentication is stateless
  from the credential submission perspective.

- **Cheerio is optional:** Since the `/portal/*` JSON APIs are directly usable, HTML parsing
  with Cheerio is not required for the core three endpoints. Cheerio may still be useful
  for the nameplate/hierarchy fields if avoiding the `__data.json` resolver complexity.

---

## 9. Open Questions & Verified Resolves

| Question | Status / Finding | Impact |
|---|---|---|
| Does `/portal/meters/{id}/energy` support date range query params? | Unverified — currently returns all available interval readings (337 records) | Exposes full history; client can slice readings as needed |
| Does `/portal/meters/search` support additional filter params beyond `q`? | Unverified — only `q` and `page` were confirmed in portal requests | Exposes search query and pagination |
| Is the session cookie name known? | **Resolved & Verified:** `__Secure-better-auth.session_token` with `Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax` | Managed automatically by tough-cookie over HTTPS |
| Are Origin/Referer headers required? | **Resolved & Verified:** Yes. SvelteKit action CSRF checks require matching `Origin` and `Referer` headers | Included in Axios session client POST /login |

---

## 10. Change Log

| Date | Change |
|---|---|
| 2026-10-24 | Initial template created |
| 2026-10-24 | Populated from browser subagent investigation (partially verified) |
| 2026-10-26 | **Full rewrite from Playwright automated investigation.** All authentication, meter search API, consumption API, and transformer API findings verified with direct network evidence. Discovered `/portal/*` internal API routes. Corrected SvelteKit enhanced form submission pattern (HTTP 200 JSON, not 303 redirect). |
| 2026-10-26 | **Live Backend Verification & Cookie Confirmation.** Verified `__Secure-better-auth.session_token` cookie and SvelteKit `Origin`/`Referer` CSRF requirements against live portal. Implemented complete Express REST API, automated test suite (34 passing tests), and OpenAPI documentation. |
