# 0010. First-slice data model and sync rules

- Status: accepted
- Date: 2026-10-02

## Context
`domain.md`, `api-contracts.md`, `architecture.md` and ADR 0002 leave several decisions Open or contradictory, and the first vertical slice cannot be built without them. Facts checked against OpenAQ's docs on 2026-10-02 (docs.openaq.org):

- Free tier rate limit is 60 requests/minute and 2,000/hour; exceeding it returns `429`, and repeated violations can suspend access. The key is sent in the `X-API-Key` header.
- `GET /v3/locations` accepts `bbox=min_lon,min_lat,max_lon,max_lat` (WGS84), `limit` up to 1000, and `page`; the response `meta.found` gives the total. Out-of-range coordinates return `422`.
- Latest values are per location (`/v3/locations/{id}/latest`) or per parameter (`/v3/parameters/{id}/latest`). Whether the per-parameter endpoint can be bbox-filtered was **not** confirmed. Until it is, a sync costs 1 + N calls for N stations.

Contradictions being resolved: `product.md` says the map shows the number of stations OpenAQ returned; ADR 0002 says an "empty response" fails the job; the contract leaves it Open.

## Decision
1. **Bootstrap.** A development organisation and project are seeded by a migration-backed seed, visible only when the dev placeholder identity is enabled (ADR 0003). The API gains read-only `GET /projects` so the frontend can discover the project id. No project-creation endpoint in the first slice.
2. **Empty result.** A well-formed OpenAQ response with zero locations is `succeeded` with `station_count = 0` and an empty layer. A malformed or empty *body* still fails with `upstream_invalid_response`. This narrows the "empty response" wording in ADR 0002; that ADR's status is unchanged, and this one governs where they differ. `no_stations_in_region` is dropped.
3. **Re-sync and layers.** A sync never mutates earlier data. Each succeeded sync job owns its own station readings. The map layer is **derived**, not stored: it is the readings of one succeeded sync job, and `map_layer_id` equals that job's id. The UI shows the latest succeeded job per region; older jobs remain addressable.
4. **Reading shape.** A station reading is a snapshot: the latest value per parameter OpenAQ returns, each with `value`, `unit` and `observed_at`. All returned parameters are stored; no history.
5. **Concurrency.** At most one `queued` or `processing` sync per region. A second start returns `409 conflict`.
6. **Limits (starting values, tunable without a new ADR).** Region bbox span at most 2° longitude and 2° latitude, rejected with `400 validation_failed`. Station cap of 50 per sync, checked against `meta.found` before any per-station call; over the cap the job fails with `too_many_stations`. The worker throttles itself below the 60/min limit.
7. **Upstream error classes.** `401`/`403` are permanent: fail immediately with `upstream_unauthorized`. `429` (honouring `Retry-After` or the reset header), network errors, timeouts and `5xx` are transient and retried up to `max_sync_retries`; exhausted retries end as `upstream_unavailable`. Other `4xx` (including `422`) and malformed bodies fail immediately with `upstream_invalid_response`. A missing API key fails the job with `upstream_unauthorized`, never a crash loop.
8. **Ids.** UUIDs, still opaque to clients.
9. **Stale jobs.** A job left `processing` by a dead worker is moved to `failed` with `timed_out` by a reaper; the timeout value is chosen at implementation and recorded in `architecture.md`.

## Alternatives considered
- Stored map-layer entity — more tables and a second lifecycle to keep consistent with sync jobs, for no first-slice benefit.
- Replace or append readings on re-sync — replace destroys history of a finished (supposedly immutable) job; append makes "current" ambiguous. Per-job ownership keeps jobs immutable and visibility rule from `domain.md` intact.
- Treat empty as `failed` — a valid answer ("no stations here") would look like an error and contradicts `product.md`.
- Project-creation endpoint — extra surface (and tenancy tests) with no value while there is one placeholder identity.
- Unbounded stations — at 1 + N calls and 60 requests/minute, a large bbox would exhaust the quota and risk key suspension.
- Retry all 4xx — permanent errors such as a bad key would only burn quota.

## Consequences
- Storage grows with every sync, since old jobs keep their readings. Retention is deferred and must be revisited before any scheduled sync.
- A 50-station cap and 2°×2° span will reject some reasonable regions. The numbers are starting points, not measured figures.
- Follow-up before implementation: confirm whether a bbox-capable latest endpoint exists, which would remove the 1 + N cost and the cap's main reason.
- Follow-up: `docs/api-contracts.md` and `docs/domain.md` carry the proposed shapes; on acceptance, flip their labels to Decided and update `architecture.md` open decisions.
- Follow-up: product doc wording on audit events is still unscheduled; not decided here.
