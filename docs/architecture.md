# Architecture

Nothing beyond the scaffold is implemented yet. Status labels: **Decided** (accepted ADR) / **Assumption** / **Open**.

## Direction

| Area | Status | Choice |
|---|---|---|
| Repo layout and tooling | Decided ([0001](decisions/0001-repo-layout-and-tooling.md)) | One repo, independent `frontend/` and `backend/` packages; no monorepo tool. Frontend: Vite, React, strict TypeScript, npm, Vitest, ESLint + Prettier. Backend: Python 3.12+, uv, Ruff, mypy, pytest, Alembic |
| Data source and ingestion | Decided ([0002](decisions/0002-data-source-and-ingestion.md)) | OpenAQ v3 as the only data source; Procrastinate (Postgres-backed) worker pulls on user-triggered sync, with retries for transient failures only |
| Second data source | Proposed ([0017](decisions/0017-luchtmeetnet-as-second-source.md)) | Luchtmeetnet (Dutch national network, no key) merged with OpenAQ by the worker at sync time: stations within 50 m are one; Luchtmeetnet failure gives a succeeded job with a warning |
| National layers | Proposed ([0018](decisions/0018-national-layer-from-background-refresh.md), [0019](decisions/0019-per-country-national-layers-in-europe.md)) | An hourly background task (own queue, queueing lock) builds one layer per country (44: Europe in OpenAQ's list, plus Turkey) from OpenAQ's bulk latest-values pages, plus Luchtmeetnet for the Netherlands, and stores each as a `national_refreshes` row with its readings; `GET /api/v1/national-layer?country=` serves the newest succeeded one per country, `GET /api/v1/countries` lists them. The newest 3 succeeded refreshes per country are kept. The country view can show two countries at once: the client asks `national-layer` per country, merges them on one map and compares fresh readings of the chosen pollutant; no endpoint changes (Assumption, no ADR yet). Regions and their user-triggered syncs are unchanged |
| UI toolkit | Decided ([0004](decisions/0004-frontend-ui-toolkit.md)) | Tailwind CSS + shadcn/ui (Radix) |
| Client state and data | Decided ([0005](decisions/0005-client-state-and-data-fetching.md)) | TanStack Query (server state), Zustand (UI state), ts-pattern for exhaustive matching |
| Map | Decided ([0006](decisions/0006-map-stack.md), [0008](decisions/0008-basemap-tile-source.md)) | MapLibre GL via `react-map-gl`; basemap style URL from config |
| Backend | Decided ([0007](decisions/0007-backend-database-and-local-dev.md)) | Python, FastAPI, JSON over HTTP |
| Database | Decided ([0007](decisions/0007-backend-database-and-local-dev.md)) | PostgreSQL + PostGIS |
| Place search | Decided ([0013](decisions/0013-place-search-for-regions.md)) | Backend `GET /api/v1/places` asks Photon (OpenStreetMap data, no key), validates the answer like OpenAQ's, caches it, limits its own calls, and returns boxes that already fit the region rules; the browser never calls the geocoder. State (cache, limit, cooldown) is in memory per process |
| Station history | Decided ([0014](decisions/0014-on-demand-station-history.md)) | Backend `GET /api/v1/map-layers/{id}/stations/{id}/history` asks OpenAQ for a station's hourly values when called and does not store them; validated like every OpenAQ answer, cached 5 minutes in memory per process, concurrent identical requests share one fetch; missing-data markers (at or below -990) are dropped everywhere. The trend chart uses Recharts |
| First-slice data model and sync rules | Decided ([0010](decisions/0010-first-slice-data-model-and-sync-rules.md)) | Seeded dev org/project; empty result is `succeeded`; layer derived from a succeeded sync job; snapshot readings with units; one in-flight sync per region (`409`); bbox span and station caps; transient vs permanent upstream errors; UUID ids |
| Identity and tenancy (first slice) | Decided ([0003](decisions/0003-first-slice-identity-and-tenancy.md)) | Dev-only placeholder identity; organisation scoping in the data-access layer; cross-organisation access returns `404` |
| Local development | Decided ([0007](decisions/0007-backend-database-and-local-dev.md)) | Docker Compose runs database, API and worker; a fresh clone starts with one command |
| End-to-end test runner | Decided ([0009](decisions/0009-playwright-for-end-to-end-tests.md)) | Playwright |

## Shape

```
Browser (React) ──HTTP──▶ API (FastAPI) ──▶ PostgreSQL/PostGIS
                              │                     ▲
                              └── enqueue ──▶ Worker ┤
                                   │                 │
                                   └──HTTP──▶ OpenAQ ┘
```

- The API owns request validation, authorization, and reads/writes of metadata.
- The worker runs independently of the API and browser; it owns the OpenAQ call, response validation, and station-reading writes, and updates sync-job status.
- The frontend only talks to the API; it never reads the database directly or calls OpenAQ itself (avoids exposing the OpenAQ API key to the browser).
- Unlike Layerline, there is no raw-file storage: the worker's input is a live API response, not an uploaded file, so nothing analogous to Layerline's storage interface is needed.

## Boundaries and constraints

- The API contract (`api-contracts.md`) is the only coupling between frontend and backend. Generating TypeScript types from the OpenAPI schema is Open.
- A sync is idempotent per job id: a retried job must not duplicate station readings. Only transient errors (network, timeout, `429`, 5xx from OpenAQ) retry; `401`/`403`, other `4xx`, and a malformed or empty-body OpenAQ response fail immediately. A well-formed response with zero stations succeeds (ADR 0010).
- A failed sync must not leave station readings visible in any layer; reading writes and the terminal status share one transaction.
- Spatial data is stored in PostGIS geometry columns with an explicit SRID. (Assumption: WGS84 / EPSG:4326 only, matching OpenAQ's coordinates.)
- The OpenAQ API key is read from the environment by the worker only; it is never sent to or readable by the frontend.
- The placeholder identity is never enabled outside development.
- Schema changes only through migrations (see `quality.md`).
- Group frontend code by feature, not by a flat `components/` directory.
- Split a package out of `frontend/` or `backend/` only when it has a second consumer, conflicting dependencies, or an independent release/test cadence.

Sync timeouts (ADR 0010 item 9): a once-a-minute task fails jobs still queued or processing 10 minutes after creation (`AIRLAYER_SYNC_TIMEOUT_MINUTES`) with `timed_out`; the OpenAQ calls of one run are cut off after half that.

## Open decisions

| # | Question | Notes |
|---|---|---|
| 1 | Large-region data delivery | Inline GeoJSON-like response for the first slice, bounded by the ADR 0010 caps; revisit if the caps are raised |
| 2 | Real authentication and roles | Replaces the placeholder identity via a later ADR |
| 3 | Row-level security | Deferred, same framing as Layerline ADR 0003 |
| 4 | Status updates to client | Polling assumed for the first slice; SSE/WebSocket deferred |
| 5 | OpenAQ rate-limit handling under concurrent syncs | Implemented per sync: the client pauses until reset when `x-ratelimit-remaining` hits 0, and a 429 waits out the reset window before the retry. Coordination across concurrent syncs of different regions is not designed (the worker runs one job at a time today) |
| 6 | Type generation from OpenAPI | Not chosen |
| 8 | AQI computation | Whether/which AQI formula to compute from raw parameters; see `product.md` |

## Explicitly out of scope for now

Deployment/hosting, observability stack, caching layers, multi-region (infrastructure sense) concerns, scheduled or recurring sync of *regions* (see `product.md`; the national layer is the one scheduled job, ADR 0018).
