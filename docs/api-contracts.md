# API contracts

Sections 0 to 6 are implemented and tested on the backend; section 7 (station history) is added by ADR 0014. Items tagged Decided come from ADR 0010. Modelled on Layerline's contract shape (same conventions and error shape) but adapted to a pull-based domain. Terms follow `domain.md`. Contract changes go through the `api-contract-review` skill.

## Conventions

- Base path `/api/v1`; JSON bodies for every request (no file upload in this domain).
- Field names `snake_case`; timestamps ISO 8601 UTC; ids are opaque strings (UUIDs in practice; Decided, ADR 0010).
- Errors use one shape (below) with a stable machine-readable `code`; clients branch on `code`, never on `message`.
- Every response for an entity includes its `id`. List endpoints use cursor pagination (`limit`, `cursor` query params; response carries `next_cursor`, null on the last page). Cursors are opaque: clients never build or parse them.
- Authentication: a development-only placeholder identity, scoped to one organisation (Decided, ADR 0003); a real scheme is **Open**. Every endpoint below returns `404` for entities outside the caller's organisation. Clients never talk to OpenAQ or see its API key.
- Dev identity (implemented): requests act as the seeded development organisation. In development only, the optional header `X-Dev-Organisation-Id: <uuid>` acts as another organisation (a non-UUID value is `400 validation_failed`). Outside development every endpoint returns `401 unauthorized`, before any body validation.
- Breaking changes require a new version path or an ADR.

### Error shape

```json
{ "error": { "code": "validation_failed", "message": "Human-readable summary", "details": [] } }
```

Initial codes: `validation_failed` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409, Decided, ADR 0010), `service_unavailable` (503, a sync could not be queued, place search is unavailable, or a station trend is unavailable), `rate_limited` (429, place search was called too often; ADR 0013). Sync-specific codes live on sync jobs (section 3), not in this envelope. Clients must render unknown codes safely.

## 0. Bootstrap reads (Decided, ADR 0010)

- `GET /api/v1/projects` → `200 { "projects": [ { "id": "…", "name": "…" } ] }`. Scoped to the caller's organisation; the first slice has one seeded project, so no pagination yet (first-slice-only).
- `GET /api/v1/projects/{project_id}/regions?limit=20&cursor=…` → `200 { "regions": [ <region as in section 1> ], "next_cursor": "…" }`. Newest first, same pagination rules as section 5. `404` if the project is outside the organisation.
- `GET /api/v1/regions/{region_id}` → `200 { "region": { … } }`, `404 not_found`.

- Errors for these reads: `400 validation_failed` (`limit` outside 1 to 100, or an invalid `cursor`), `401 unauthorized` (outside development). A malformed id in a path is `404 not_found`, not `400`.

These let the UI restore its state after a reload; there is no project-creation endpoint in the first slice.

## 1. Create a region

`POST /api/v1/projects/{project_id}/regions`

```json
{ "name": "…", "bbox": [4.85, 52.35, 4.95, 52.40] }
```

Success `201 Created`:

```json
{ "region": { "id": "…", "project_id": "…", "name": "…", "bbox": [4.85, 52.35, 4.95, 52.40], "created_at": "…" } }
```

- `bbox` is `[min_lon, min_lat, max_lon, max_lat]` in WGS84, matching the map layer `bbox` shape below (Decided, for consistency).
- Errors: `400 validation_failed` (malformed, inverted, or out-of-range bbox; span over 2° longitude or 2° latitude (a box exactly 2° wide is valid; floating-point noise below 0.000000001° is ignored), a starting value decided in ADR 0010; antimeridian-crossing boxes are not supported and are rejected as inverted), `404 not_found` (project), `401`/`403`.

## 2. Start a sync job for a region

`POST /api/v1/regions/{region_id}/syncs`

Success `202 Accepted`:

```json
{
  "sync_job": {
    "id": "…", "region_id": "…", "status": "queued", "created_at": "…",
    "started_at": null, "finished_at": null, "station_count": null, "map_layer_id": null, "errors": []
  }
}
```

The body has the same shape as a sync job in section 3 (all keys always present).

Errors: `404 not_found` (region missing or in another organisation; a malformed id is also `404`), `409 conflict` (a `queued` or `processing` sync already exists for the region; Decided, ADR 0010), `503 service_unavailable` (could not be queued), `400 validation_failed` (malformed `X-Dev-Organisation-Id`), `401 unauthorized` (outside development).

Notes:
- Returns before the OpenAQ call is made; the job is then run by the worker.
- If the job cannot be queued, it is marked `failed` with `processing_error` and the call returns `503 service_unavailable`, so the region is not left blocked.
- Idempotency keys are not part of the first slice; the 409 rule is what protects against a double submit.

## 3. Get sync status

`GET /api/v1/syncs/{sync_job_id}`

`200 OK`:

```json
{
  "sync_job": {
    "id": "…",
    "region_id": "…",
    "status": "failed",
    "created_at": "…",
    "started_at": "…",
    "finished_at": "…",
    "station_count": null,
    "map_layer_id": null,
    "errors": [ { "code": "upstream_unavailable", "message": "…" } ],
    "warnings": []
  }
}
```

- `status`: `queued | processing | succeeded | failed`.
- `started_at` is null until the job is `processing`; `finished_at` is null until a terminal status (`started_at` is additive, Decided, ADR 0010).
- `station_count` and `map_layer_id` are non-null only when `succeeded`; `errors` is non-empty only when `failed`. `map_layer_id` equals the sync job's own `id` (the layer is derived from the job, Decided, ADR 0010).
- Sync error codes (clients branch on `code`; unknown codes must render safely): `upstream_unavailable` (OpenAQ unreachable, `429` or `5xx` after retries), `upstream_unauthorized` (OpenAQ rejected the key, or no key configured; not retried), `upstream_invalid_response` (malformed body or other non-retryable `4xx`), `too_many_stations` (bbox matches more than the 50-station cap, Decided, ADR 0010), `timed_out` (a job abandoned by a dead worker or a lost enqueue, or one whose OpenAQ calls ran past half the 10-minute timeout), `processing_error`.
- A well-formed OpenAQ response with zero stations is `succeeded` with `station_count: 0` (Decided, ADR 0010); `no_stations_in_region` no longer exists.
- `warnings` (additive, Proposed, ADR 0017) is non-empty only on a `succeeded` job that is missing part of its data: `{ "code": "luchtmeetnet_unavailable", "message": "…" }` means Luchtmeetnet could not be reached or answered something unusable, and the layer holds OpenAQ's stations only. OpenAQ failing is still `failed`. Unknown codes must render safely.
- A job still `queued` or `processing` after 10 minutes (a starting value, `AIRLAYER_SYNC_TIMEOUT_MINUTES`) is failed with `timed_out` by a once-a-minute background task.
- Errors: `404 not_found` (unknown id, another organisation's job, or a malformed id), `400 validation_failed` (malformed `X-Dev-Organisation-Id`), `401 unauthorized` (outside development).

## 4. Get a map layer

`GET /api/v1/map-layers/{map_layer_id}`

`200 OK`:

```json
{
  "map_layer": {
    "id": "…",
    "region_id": "…",
    "station_count": 42,
    "bbox": [4.85, 52.35, 4.95, 52.40],
    "property_keys": ["pm25", "no2", "o3"]
  },
  "stations": { "type": "FeatureCollection", "features": [] }
}
```

- `map_layer_id` is a succeeded sync job's id; any other id (including a failed job's) is `404 not_found` (Decided, ADR 0010).
- Each feature's `properties` (Decided, ADR 0010):

  ```json
  { "name": "…", "sources": ["openaq", "luchtmeetnet"], "readings": { "pm25": { "value": 12.4, "unit": "µg/m³", "observed_at": "…", "source": "luchtmeetnet" } } }
  ```

  `sources` and each reading's `source` (`openaq` or `luchtmeetnet`) are additive (Proposed, ADR 0017). A station within 50 m of another source's station is one feature: its `sources` lists both, and each pollutant carries the newer of the two readings (Luchtmeetnet on a tie), only when both report the same unit. Luchtmeetnet adds pollutants OpenAQ lacks (`fn` soot, `bcwb` black carbon from wood burning, `ps` ultrafine particles, `c6h6` benzene and others); their units come from a fixed table (Assumption, ADR 0017).

  `readings` holds the latest value per parameter the sources returned; `value` is a number. A value at or below `-990`, which OpenAQ sends as a marker where a sensor has no measurement (`-999`, `-998` and `-995` were seen in real responses), is dropped instead of stored, and a layer stored before this rule is read without such values; values above `-990`, including small negatives, are kept (Decided, ADR 0014; the threshold is a starting value). Readings are not filtered by age: a station that stopped reporting keeps its old `observed_at`, so clients can show how stale it is. The filter below compares against `readings.<property>.value`.

- Coordinates are `[longitude, latitude]` in WGS84, matching Layerline's convention (Decided).
- Each feature's `id` is the stored station reading's own id (Decided, for stable client-side matching across a filtered and unfiltered request, same guarantee as Layerline).
- Optional filter: `?property=<key>&value=<number>&comparator=<op>`. `property` and `value` are given together or not at all, and `comparator` needs both (`400 validation_failed` otherwise). `comparator` is one of `=`, `>`, `>=`, `<`, `<=` (default `=`). `value` must match `-?[0-9]+(\.[0-9]+)?` (ASCII digits, no exponent or leading `+`) and be finite, because readings are numeric; this replaces the Layerline text-value grammar. `property` must be one of the layer's `property_keys`, otherwise `400 validation_failed` (the message lists the valid keys). A station that lacks an otherwise-valid property is excluded from the match, not an error. The filter compares against `readings.<property>.value` exactly: `=` matches only the stored number (12.4), not a rounded display of it (12.37 shown as 12.4). Order of checks: a malformed id is `404`; then the filter syntax (`400`); then the layer lookup (`404` for an unknown, foreign or unfinished layer, before the property is checked against `property_keys`, so another organisation never sees a layer's keys). Repeating a query parameter uses the last value.
- `property_keys`: distinct pollutant parameter names across the layer's stations, sorted. Units are on each reading, not here.
- `station_count` and `property_keys` describe the whole layer, not the filtered subset, so a filter UI stays stable while the filter changes; the number of matches is the length of `features`.
- `bbox` is the region's bounding box. Features are ordered by OpenAQ location id, stations only Luchtmeetnet has coming last (by their Luchtmeetnet number).
- Size: the layer is returned inline; the 50-station cap bounds it, which is why there is no pagination (first-slice-only).
- Errors: `400 validation_failed` (bad filter, malformed `X-Dev-Organisation-Id`), `404 not_found` (unknown id, another organisation's, not a succeeded job, or a malformed id), `401 unauthorized` (outside development).

## 5. List syncs of a region

`GET /api/v1/regions/{region_id}/syncs?limit=20&cursor=…`

`200 OK`:

```json
{
  "sync_jobs": [ { "id": "…", "region_id": "…", "status": "succeeded", "…": "all keys of a sync job, as in section 3" } ],
  "next_cursor": "…"
}
```

- Each item has the same shape as a sync job in section 3.
- Newest first (by `created_at`, ties broken by `id`). `limit` default 20, maximum 100.
- This list is how clients discover a region's map layers (`map_layer_id` on succeeded jobs); there is no separate map-layer list endpoint, same as Layerline.
- Errors: `400 validation_failed` (bad `limit` or `cursor`), `404 not_found` (region missing, in another organisation, or a malformed id), `401 unauthorized` (outside development).

## 6. Search places (Decided, ADR 0013)

`GET /api/v1/places?q=<text>`

Looks a place name up through Photon (OpenStreetMap data) so a region can be defined by name instead of coordinates. The browser never calls the geocoder; this endpoint does, and the search text is therefore seen by our server and by Photon, not by the browser's address.

`200 OK`:

```json
{
  "places": [
    {
      "id": "R271110",
      "name": "Amsterdam",
      "detail": "North Holland, Netherlands",
      "kind": "city",
      "point": [4.8979755, 52.3745403],
      "bbox": [4.7288, 52.2782, 5.0792, 52.4311]
    }
  ]
}
```

- `q` is required: 3 to 100 characters after trimming whitespace (`400 validation_failed` otherwise). Matching ignores case and repeated spaces.
- At most 5 places, best match first. Results with the same `name` and `detail` are collapsed to the first.
- `id` is an opaque string (OpenStreetMap type and id); use it only as a key. `name` is at most 200 characters, `kind` 50 and `detail` 300. `detail` is the containing city, county, state and country, without repeats and without the name itself (empty string when unknown). `kind` is Photon's place type (for example `city`, `district`, `street`); clients must treat unknown kinds as plain text. `point` is `[longitude, latitude]` in WGS84.
- All text comes from OpenStreetMap and must be shown as plain text, never as HTML.
- `bbox` is `[min_lon, min_lat, max_lon, max_lat]` and is already a valid region box (section 1): each side is at least 0.1 degrees (a smaller place, or one with only a point, is widened around its centre) and at most 2 degrees, measured in whole ten-thousandths of a degree. A place whose extent is outside the world is treated like one that is too large. `bbox` is `null` for a place larger than 2 degrees on a side (a country, a large region); clients show it as too large instead of using it. These 0.1 and 2 degree values are starting values.
- A single result that Photon sends in an unexpected shape is dropped; a response that is not the expected shape at all is an error.
- Results are cached on the server for 10 minutes per normalised query. Failures are not cached, but after one Photon is not asked again for 30 seconds: new searches during that time get `503` at once (cached answers are still served). Searches for the same text at the same moment share one Photon request. The server also keeps itself under 20 Photon requests per 10 seconds per server process (starting values; with several worker processes the total is higher); a place box that passes the 2 degree rule can still contain more stations than the sync cap, which is reported when it is synced (`too_many_stations`).
- Authentication as for every endpoint (dev placeholder identity, `401 unauthorized` outside development).
- Errors: `400 validation_failed` (`q` missing, too short or too long; malformed `X-Dev-Organisation-Id`), `401 unauthorized`, `429 rate_limited` (the server has already made too many Photon requests in a short time; cached answers do not count; retry shortly), `503 service_unavailable` (Photon unreachable, slow, answering with an error, or sending an unusable response; clients keep the typed and drawn ways of defining a region).

## 7. Station history (Decided, ADR 0014)

`GET /api/v1/map-layers/{map_layer_id}/stations/{station_id}/history?property=pm25&hours=24`

Hourly values of one pollutant at one station, fetched from OpenAQ when the request arrives and not stored. The browser never calls OpenAQ.

`200 OK`:

```json
{
  "history": {
    "property": "pm25",
    "unit": "µg/m³",
    "interval": "hour",
    "from": "2026-10-02T14:00:00Z",
    "to": "2026-10-03T14:00:00Z",
    "points": [ { "at": "2026-10-02T15:00:00Z", "value": 3.9 } ]
  }
}
```

- `station_id` is the `id` of a feature of that map layer (section 4). `map_layer_id` and `station_id` outside the caller's organisation, unknown, or not a succeeded job's layer are `404 not_found`; a malformed id is also `404`.
- `property` is required and must be one of the layer's `property_keys` (`400 validation_failed` otherwise; the message lists the keys). A station that does not report that property, has no sensor for it, or is only known to Luchtmeetnet (no OpenAQ location, ADR 0017) returns `points: []` and `unit: null`.
- `hours` is a whole number from 1 to 168, default 24 (`400 validation_failed` otherwise). `from` is the start of the window and `to` its end, both UTC: the moment the data was fetched from OpenAQ, which is up to 5 minutes earlier when the answer comes from the cache.
- `at` is the end of the hour a value covers (OpenAQ `period.datetimeTo`). Points are ordered oldest first, one per hour at most, and values at or below `-990` are left out (section 4). A gap in the data is a missing point, never a zero.
- `unit` is the unit OpenAQ reports for the sensor; it is `null` only when the station has no sensor for the property.
- OpenAQ unreachable, slow, rate limiting us (the server never waits out a rate-limit pause inside a request), rejecting the key, answering with more hours than asked for, or answering with a response that does not match the expected shape is `503 service_unavailable`; so is a server with no OpenAQ key configured, but only after the ids, `property` and `hours` have been checked (`404`, `400`); no partial points are returned. The `message` says the trend is unavailable, not why.
- Responses are cached on the server for 5 minutes per OpenAQ location, pollutant and `hours` (a starting value). Failures are not cached. Identical requests that arrive while one is being fetched share its answer.
- Authentication as for every endpoint (dev placeholder identity, `401 unauthorized` outside development).
- Errors: `400 validation_failed` (bad `property` or `hours`, malformed `X-Dev-Organisation-Id`), `401 unauthorized`, `404 not_found`, `503 service_unavailable`.

## 8. National layer (Proposed, ADR 0018)

`GET /api/v1/national-layer?property=pm25&value=10&comparator=>=`

The merged stations of OpenAQ and Luchtmeetnet for the whole Netherlands, refreshed hourly by a background task; the request itself reads stored data and calls no upstream.

`200 OK`: as section 4, except the layer belongs to no region and says when it was built:

```json
{
  "map_layer": {
    "id": "…",
    "region_id": null,
    "refreshed_at": "2026-10-04T12:41:07Z",
    "station_count": 312,
    "bbox": [3.2, 50.7, 7.3, 53.7],
    "property_keys": ["pm25", "no2", "o3"]
  },
  "stations": { "type": "FeatureCollection", "features": [] }
}
```

- `id` is the newest succeeded refresh's id. It changes with every refresh, so clients do not cache it across hours. `refreshed_at` is when that refresh finished, UTC. `region_id` is always `null` here. Section 4 layers are unchanged: they carry neither `refreshed_at` nor a null `region_id`.
- `bbox` is the fixed Netherlands extent `[3.2, 50.7, 7.3, 53.7]`, not derived from the stations. OpenAQ is asked by country, so stations outside the country are not in the layer.
- Features, filter, filter errors, `station_count`, `property_keys`, staleness and the missing-value marker rule are exactly as in section 4.
- The station history endpoint (section 7) accepts this layer's `id` as `map_layer_id`.
- `404 not_found` until a refresh has succeeded. A later failed refresh does not change the answer; the previous layer is served and its `refreshed_at` shows its age.
- Authentication as for every endpoint. The layer is public data and is the same for every organisation.
- Errors: `400 validation_failed` (filter), `401 unauthorized`, `404 not_found`.

## Open questions

- Retention of old national refreshes is not decided (ADR 0018); all are kept.
- Stale stations: a station that stopped reporting keeps its old readings (e.g. February data still returned in October). Clients see this through `observed_at`; whether the API should hide or flag stations older than some age is not decided.

- Does the API ever expose OpenAQ's own station/location id to the client, or is it fully internal? (Internal until decided.)
- Real authentication scheme (replaces the dev identity via a later ADR).
- Antimeridian-crossing regions.
- A bbox-capable OpenAQ latest-values endpoint, which would lift the 1 + N call cost behind the station cap (ADR 0010 follow-up).
