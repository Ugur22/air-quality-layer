# Product

Status labels: **Decided** / **Assumption** / **Open**.

## Problem (Assumption)

Air-quality readings exist in public monitoring networks, but seeing "what does the air look like right now, here" requires picking a data source, pulling its readings for an area, making sense of inconsistent units and station coverage, and putting it on a map. Doing this by hand, per area, is slow, and there is no record of what was pulled when or why a pull failed.

## Intended users (Assumption)

Roles, not personas; no real users exist yet.

- **Area watcher** — defines a region they care about (a neighbourhood, a city) and wants to know its current readings without hunting across stations.
- **Reviewer / analyst** — inspects a region's stations on a map and filters by pollutant or threshold.
- **Organisation admin** — controls who can access an organisation's regions. (Open: whether this role exists in the first release.)

## Product promise (Decided, as an intent)

1. Define a region and get an explicit sync outcome: succeeded, or failed with a human-readable reason.
2. See a region's current station readings as a map layer.
3. Every change to data is attributable (audit events).

## Non-goals (Decided for the first slice)

- No alerts, notifications, or thresholds that trigger anything.
- No AQI index computation; the first slice shows a station's raw parameter values and units. Which AQI formula (if any) to adopt later is **Open**.
- No historical time series or trend charts (planned later, out of scope now; Layerline added an analogous chart after its first slice, see `docs/decisions/README.md` pattern).
- No scheduled or recurring sync. Sync is triggered by a user action only. Backlog (not planned): revisit only once a pull-based refresh cadence is actually wanted, which also requires deciding what a re-sync does to existing station readings (see `domain.md`).
- No real-time collaboration, no offline mode.
- No third-party integrations, billing, or public API for external consumers.
- No claims about scale, coverage, or data accuracy beyond what OpenAQ itself reports.
- Not a general GIS; no spatial analysis tooling (buffering, routing, etc.).
- No editing of station readings; they are a read-only reflection of the upstream source.

## First vertical slice

Smallest path that touches every layer of the stack:

1. A user defines a region: a name and a bounding box (lat/lon min/max).
2. The backend creates a sync job and returns its id.
3. A worker calls OpenAQ for locations and latest measurements inside the bounding box, validates the response, and writes station readings.
4. The client polls sync status until `succeeded` or `failed`; failures show error details.
5. On success, the map UI fetches the resulting map layer and renders its station readings.

Acceptance for the slice:
- an OpenAQ response that fails validation yields a `failed` job with a human-readable error and no partial station readings visible;
- a successful sync renders the same number of stations OpenAQ returned for the bounding box;
- the flow is covered by one end-to-end test.

Deliberately excluded from the first slice: authentication beyond a placeholder (Open: see `architecture.md`), AQI computation, historical data, and a region-management UI beyond the single bounding-box form; see `api-contracts.md` for exact scope once it is implemented.

## Open questions

- Is multi-tenancy (organisations) enforced in the first slice, or only modelled?
- Maximum region size (bounding-box area) and station count per sync?
- Which OpenAQ parameters (PM2.5, PM10, O3, NO2, SO2, CO, ...) are shown by default, and is that configurable per region?
