# Engineering Reflection  -  Flock Energy Take-Home Assignment

This document records the architectural findings, technical trade-offs, debugging challenges, and lessons learned during the design and implementation of the Urja Meter Ops REST API wrapper.

---

### 1. What assumptions did I make?

- **Authentication Protocol:** Standard web patterns suggested that a form submission to `/login` would execute a standard POST followed by an HTTP 303 redirect and a `Set-Cookie` header. In reality, the portal uses SvelteKit client-side form enhancement (`use:enhance`), issuing a `fetch` request with `x-sveltekit-action: true` and returning HTTP 200 with JSON payload `{"type":"redirect","status":303,"location":"/meters"}`.
- **CSRF Protection:** Initially assumed no CSRF protection existed because the login form contained no hidden tokens. However, SvelteKit validates request origins: omitting `Origin` or `Referer` headers in the programmatic Axios client resulted in an HTTP 403 Forbidden response.
- **Data Source Nature:** We originally anticipated scraping HTML tables with Cheerio. Browser network inspection revealed that the frontend queries internal backend JSON endpoints (`/portal/meters/search`, `/portal/meters/{id}/geo`, `/portal/meters/{id}/energy`), allowing direct JSON consumption without DOM parsing.
- **Consumption Units & Semantics:** The energy endpoint returned string readings labeled `kwh` and `kvah`. By examining successive 30-minute intervals, we verified these are cumulative meter readings (like an odometer), not period consumption deltas.
- **Meter Identifiers:** We assumed all meter IDs match the regex pattern `^J\d{6}$` based on the 403 total meters cataloged in the system (`J100000` to `J100402`).

> **[Candidate Input for Interview]:**
> Confirm if you had any additional assumptions about the operational environment (e.g., expected concurrent users or network latency constraints).

---

### 2. Which part was most difficult, and how did I get unstuck?

- **The Challenge:** Programmatic authentication against SvelteKit. While interactive browser sessions logged in smoothly, automated Axios POST requests initially failed with HTTP 403 Forbidden.
- **How We Got Unstuck:** Rather than guessing headers or trying random retry loops, we inspected the complete network traffic captured in `scripts/evidence/session.har`. Comparing browser request headers with the Axios configuration revealed that SvelteKit requires both `Origin: https://urja-ops.flockenergy.tech` and `Referer: https://urja-ops.flockenergy.tech/login`. Once passed alongside `x-sveltekit-action: true`, the portal responded with HTTP 200 and set the `__Secure-better-auth.session_token` cookie immediately.
- **Indexed SvelteKit Deserialization:** The meter nameplate endpoint (`/meters/{id}/__data.json`) returned data in SvelteKit's flattened index-reference array rather than standard nested JSON. Writing a recursive graph resolver (`resolveSkNode`) and handling SvelteKit's `{ type: "error", status: 404 }` node structure resolved the attributes cleanly without external scraping dependencies.

> **[Candidate Input for Interview]:**
> Highlight your own perspective on what concepts you found most challenging (e.g. reverse-engineering SvelteKit internals vs. configuring cookie-jar persistence) when explaining this in technical interviews.

---

### 3. If I had another day, what would I improve?

1. **In-Memory Caching:** Implement a lightweight TTL cache (5-15 minutes) for static meter nameplates and hierarchy details. Since meter hardware specifications rarely change, caching would reduce redundant upstream portal calls.
2. **Client-Side Energy Filtering:** Since `/portal/meters/{id}/energy` returns all available intervals without query parameters, add optional `startDate` and `endDate` query parameters to the wrapper's endpoint to filter the array in memory.
3. **Computed Consumption Deltas:** Add an optional `?compute_deltas=true` query parameter to `GET /api/v1/meters/:id/consumption` that calculates consumption differences between consecutive timestamps.
4. **Upstream Rate Limiting & Concurrency Control:** Introduce an outbound request queue to prevent concurrent wrapper requests from overwhelming the single legacy portal operator session.

> **[Candidate Input for Interview]:**
> Add any specific personal architectural ideas you would like to mention, such as adding Prometheus metrics, Docker containerization, or Redis session caching.

---

### 4. What mistake did I make while solving this?

- **Relying on Manual Inspection First:** During the initial investigation phase, trying to manually inspect requests through browser DevTools and interactive subagent prompts led to session disconnections and incomplete headers. The project accelerated significantly once we wrote a local Playwright script (`scripts/investigate.js`) to capture complete HAR archives and network logs automatically.
- **ESM Dependency Mismatch:** Initially installing the newest version of `axios-cookiejar-support` (v7) introduced pure-ESM compatibility issues with Jest under CommonJS. Recognizing that using the stable, CommonJS-native v4 release solved the issue cleanly avoided over-complicating the project with experimental VM flags or transpilers.
- **SvelteKit 404 Node Handling:** In early testing, nonexistent meters returned HTTP 502 instead of 404 because SvelteKit renders an error layout returning HTTP 200 with an internal `{ type: "error", status: 404 }` node. Updating `fetchMeterDetail` to inspect `nodes[2]` for error payloads fixed the behavior to return a clean 404.

> **[Candidate Input for Interview]:**
> Review this section to ensure the described debugging workflow aligns with how you will explain your problem-solving process during the technical interview.

---

### 5. If I were reviewing my submission, what would I criticize?

- **Dual Upstream Requests for Meter Detail:** `GET /api/v1/meters/:id` issues two separate upstream requests (`/meters/{id}/__data.json` and `/portal/meters/{id}/geo`) via `Promise.all`. While parallelized, this still imposes double request overhead per query.
- **Memory Footprint of Full History:** The consumption endpoint fetches all 337 readings in memory on every request. For meters with years of interval data, this would require streaming or pagination.
- **Single Process In-Memory Cookie Jar:** The cookie jar is stored in-memory in the active Node.js process. In a distributed multi-instance deployment (e.g. behind a load balancer), sessions would not be shared across pods unless backed by Redis.

> **[Candidate Input for Interview]:**
> You can add any personal critique regarding your code style, test naming conventions, or documentation formatting.
