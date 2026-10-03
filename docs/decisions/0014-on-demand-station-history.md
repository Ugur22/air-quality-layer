# 0014. On-demand station history, and a wider missing-data marker rule

- Status: accepted
- Date: 2026-10-03

## Context
A station's popup shows only its latest reading per pollutant. The user wants a trend chart for a station when it is clicked, as Layerline has for a numeric property. `product.md` listed historical time series as a non-goal, and `domain.md` decides that AirLayer stores a snapshot only. A trend needs several readings per station, which AirLayer does not hold.

Facts checked on 2026-10-03 against the real OpenAQ v3 API with the project's key:

- `GET /v3/locations/{id}/sensors` lists a location's sensors with `id` and `parameter.name` / `parameter.units`. Our stored readings keep the OpenAQ location id but not sensor ids.
- `GET /v3/sensors/{id}/hours` returns hourly averages, oldest first. Each result has `value`, `parameter.units`, and `period.datetimeFrom.utc` / `period.datetimeTo.utc`. `meta.found` is a number, or a string such as `">100"` when capped.
- The time range parameters are `datetime_from` and `datetime_to`. `date_from` and `date_to` are silently ignored and the call then returns the oldest data (2016) with status 200, so a wrong name returns plausible but wrong points.
- The rate limit is 60 requests per minute (`x-ratelimit-limit`), the same budget a sync uses (ADR 0010).
- Missing-data markers are not only `-999`. In the development database every negative stored value was a marker: `-999` (7), `-998` (2), `-995` (9); no small negative was present. One `-998` appeared on the map as a real reading.

## Decision
1. **History is fetched on demand and not stored.** A new endpoint returns the last N hourly values of one pollutant at one station by asking OpenAQ when the request arrives (`api-contracts.md` section 7). Nothing is written to the database, so the snapshot-only decision in `domain.md` stays true and no migration is needed.
2. **The station is addressed through its map layer.** The path carries the layer id and the station id the layer already returns, so the existing organisation scoping applies and a foreign or unknown id is `404`. The server resolves the OpenAQ location id from the stored reading, looks up the pollutant's sensor, then asks for its hourly values.
3. **Validate like every OpenAQ response.** Strict shape checks, finite numbers, UTC timestamps; any violation fails the request (`503 service_unavailable`) rather than returning partial points.
4. **Cache in memory for 5 minutes** per (location, pollutant, hours), as place search does, so reopening a station does not spend the 60 per minute budget. 5 minutes and the other numbers are starting values.
5. **Missing-data markers are values at or below -990.** They are dropped from syncs (as `-999` was), from history, and when an already stored layer is read, so existing layers stop showing them without rewriting data. Values above -990, including small negatives, are kept. The threshold is a starting value chosen from the observed markers; revisit if OpenAQ documents a marker list.
6. **The trend chart uses Recharts** (frontend), as Layerline does, used directly with the project's colour tokens and without Layerline's shadcn chart wrapper. This adds `recharts`, and declares `@radix-ui/react-dialog` (already installed through the combobox) for the station dialog.
7. **The server never waits out an OpenAQ rate-limit pause inside a request** (it answers 503), shares one fetch between identical concurrent requests, and does not hold a database connection while it calls OpenAQ.
8. `product.md`: stored history and scheduled collection remain non-goals; one on-demand trend for one station is in scope.

## Alternatives considered
- **Store a history table on each sync** — richer later (works offline from OpenAQ, supports many stations at once), but needs a migration, a retention rule, and a decision on what a re-sync does to old readings (`domain.md` open question). Kept as the follow-up if on-demand proves too slow or too costly.
- **Browser calls OpenAQ directly** — breaks "clients never talk to OpenAQ or see its API key" (`api-contracts.md`).
- **Raw `/measurements` instead of `/hours`** — finer, but up to 1000 results per page and noisier for a 24 hour chart; hourly is enough for the first version.
- **Drop only `-999` (the old rule)** — leaves `-998` and `-995` on the map, as observed.
- **Plain SVG instead of Recharts** — no dependency, but hand-built axes, tooltips and responsiveness; the user chose Recharts.

## Consequences
- Opening a station costs 2 OpenAQ calls (sensor lookup, hourly values) on a cache miss, against the shared 60 per minute limit. A burst of clicks can be rate limited; the UI must show that as an unavailable trend, not an error page.
- The trend depends on OpenAQ being reachable at click time; a station that stopped reporting returns an empty list, which the UI shows as "no recent readings".
- The sensor lookup could be avoided by storing sensor ids at sync time; that needs a migration and is left out of this decision.
- Existing stored layers that contain markers are filtered when read; the rows themselves are unchanged.
