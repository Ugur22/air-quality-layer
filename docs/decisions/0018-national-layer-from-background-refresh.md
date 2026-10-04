# 0018. A national layer kept fresh by a background refresh

- Status: proposed
- Date: 2026-10-04

## Context
A region is one box of at most 2 degrees, pulled live by a user-triggered sync (ADR 0002, 0010). The Netherlands is about 3.9 by 2.8 degrees, and a live pull of the whole country does not fit the existing limits. Measured on 2026-10-04: OpenAQ has 273 Dutch locations (provider split: AirGradient 131, EEA 85, Netherlands 57; 220 reported in the last week), and the Luchtmeetnet catalogue holds about 107. Latest values cost one call per station on both sources (ADR 0010, 0017), against 60 calls a minute at OpenAQ and 100 per 5 minutes at Luchtmeetnet. A user cannot wait that long, and the 50-station cap (ADR 0010) would reject the result.

## Decision
1. **A national layer is a second kind of map layer**, owned by no region and no organisation (Dutch air-quality data is public). It is the merged stations of both sources for the whole country, built exactly as a sync builds a region layer (same clients, same merge, ADR 0017).
2. **A background task refreshes it every hour** (the sources publish hourly), on its own `national` queue. A queueing lock stops a second one being queued, and a unique index on `processing` refreshes stops two running at once. `python -m airlayer.refresh_national` runs one by hand for the first fill. A refresh is a row in `national_refreshes` with the status values of a sync job (`processing`, `succeeded`, `failed`); its readings are `station_readings` rows pointing at it.
3. **OpenAQ is asked by country** (`countries_id` for the Netherlands, 94), not by a box, so Belgian and German stations inside a rectangle are not included. Luchtmeetnet contributes its whole catalogue. The national station cap is its own setting (starting value 600), not the 50 of a region.
4. **The layer served is the newest succeeded refresh.** A failed refresh stores nothing and never blanks the map. Luchtmeetnet failing leaves a warning on a succeeded refresh, as for a sync (ADR 0017); OpenAQ failing fails it. Before any refresh has succeeded the layer is `404 not_found`.
5. **Read-only endpoint** `GET /api/v1/national-layer` returns the same `map_layer` and `stations` shapes as section 4 of the contract, the same filter, and `refreshed_at`. The station history endpoint accepts the national layer's id.
6. **Retention is Open.** Old refreshes are kept (about 400 rows an hour); pruning deletes data and needs its own approval.
7. **Region mode is unchanged.** Place search, drawing, the 2 degree cap and per-region syncs stay as they are.

## Alternatives considered
- **Raise the 2 degree and 50 station caps** — a live sync would run for ten minutes and hit rate limits; the layer would still be one blocking request.
- **Luchtmeetnet only** — no rate trouble, but loses OpenAQ's extra sensors (131 AirGradient locations).
- **Model it as a region plus syncs** — needs an organisation and a project for public data, and keeps the user-triggered, one-in-flight model that does not fit an hourly job.
- **Query the sources from the browser or on request** — breaks ADR 0002 (the key stays on the server) and the rate limits.
- **Province boundaries and aggregates** — not needed to show the whole country; revisit if a province view is wanted.

## Consequences
- New migration: `national_refreshes`; `station_readings.sync_job_id` becomes nullable and `national_refresh_id` is added, with a check that exactly one of the two is set.
- A refresh takes about nine minutes (roughly 380 paced calls). It runs on its own `national` queue, served by its own worker service (`worker-national` in Compose), so it cannot hold up region syncs or let the reaper time them out; the original worker listens to the `default` queue only.
- The refresh shares the process-wide Luchtmeetnet pacer with syncs (ADR 0017), so a sync that overlaps a refresh waits longer on that source.
- ADR 0002's "user-triggered sync only" and the "scheduled or recurring sync" out-of-scope line are narrowed: regions stay user-triggered, the national layer is scheduled.
- Stale stations stay in the layer with their old `observed_at`, as in a region layer.
