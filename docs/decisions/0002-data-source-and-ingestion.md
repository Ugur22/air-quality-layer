# 0002. Data source and ingestion

- Status: accepted
- Date: 2026-10-02

## Context
AirLayer needs one public air-quality data source and a way to pull it into a region's map layer on user-triggered sync (`product.md`, `domain.md`). The source must be free for a portfolio project, have no commercial-use gate that would complicate showing the project publicly, and expose per-station geometry plus pollutant parameters so it maps onto the same "geometry + properties" shape Layerline uses for its spatial features. Four candidates were compared: OpenAQ, WAQI (World Air Quality Index), AirNow, and IQAir (AirVisual).

- **OpenAQ v3**: free, open license, global coverage, no commercial-use gate. Data model is Location → Sensor → Measurement, aggregating government and reference-grade sensors worldwide. Requires a free API key; rate limits are generous for polling a bounded region (on the order of tens of requests per minute per key) but not officially pinned down to an exact number as of this writing.
- **WAQI**: simple to integrate, broad global station coverage, offers demo tokens, but is less open about licensing for anything beyond casual/demo use.
- **AirNow**: official U.S. EPA source, free, no account needed for some endpoints, highly trusted — but U.S.-only, which conflicts with a region-by-bounding-box model that should work anywhere.
- **IQAir (AirVisual)**: free tier capped at 500 calls/day on its Community plan, strong global coverage including areas AirNow doesn't reach, but the free tier's daily cap is tighter than OpenAQ's per-minute model for a project that syncs on demand.

## Decision
Use **OpenAQ v3** as the only air-quality data source for the first slice. Ingestion runs through a **Procrastinate** (Postgres-backed) worker, the same queue technology Layerline uses, triggered by a user-initiated sync (`POST /api/v1/regions/{region_id}/syncs`), not on a schedule. The worker calls OpenAQ's locations/measurements endpoints for a region's bounding box, validates the response, and writes station readings inside the same transaction as the terminal job status. Only transient failures (network errors, timeouts, 5xx) retry; a malformed or empty response fails the job immediately. The OpenAQ API key is a worker-only environment variable, never sent to the frontend.

## Alternatives considered
- WAQI — rejected: simpler API, but OpenAQ's open-data mandate and lack of a commercial-use gate are a better fit for a publicly shown portfolio project, and its structured Location/Sensor/Measurement model needs less reshaping to fit the domain model.
- AirNow — rejected: U.S.-only coverage conflicts with a bounding-box-anywhere region model.
- IQAir — rejected: global coverage is attractive, but the 500-calls/day free cap is more restrictive for iterative development (every sync and every test run against the real API consumes it) than OpenAQ's per-minute limit.
- Celery + Redis instead of Procrastinate — rejected for the same reason Layerline chose Procrastinate: one fewer moving part (no separate broker) when Postgres is already required.

## Consequences
- An OpenAQ account and API key are required for local development against real data; the worker's unit tests mock the OpenAQ HTTP call at the boundary (`docs/quality.md`) so CI and local checks do not depend on OpenAQ's availability or the key being present.
- OpenAQ's exact rate limit is not pinned down; if concurrent syncs or frequent re-syncing becomes real usage, revisit with a backoff/queueing strategy (`architecture.md` open decision #5).
- No fallback data source exists; if OpenAQ changes its terms or availability, this ADR needs to be revisited (write a new ADR, do not edit this one).
- Because ingestion is a pull, not a file upload, AirLayer has no analogue to Layerline's raw-file storage layer.
