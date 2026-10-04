# 0017. Luchtmeetnet as a second source, merged at sync time

- Status: proposed
- Date: 2026-10-04

## Context
ADR 0002 made OpenAQ the only source. A comparison for Amsterdam (4.75–5.05°E, 52.28–52.45°N) showed what a second, Netherlands-only source adds: Luchtmeetnet (RIVM and regional health services, `api.luchtmeetnet.nl/open_api`, no key, "fair use", 100 requests per 5 minutes, hourly data).

- 15 of its 16 stations in that box are already on OpenAQ (provider `EEA`) at identical coordinates, so station count barely grows (+1). OpenAQ also has stations Luchtmeetnet lacks (7 AirGradient sensors, `Amsterdam-A10 west`).
- Luchtmeetnet readings were 0.5 h old against 9.5 h on OpenAQ in one snapshot, and one OpenAQ station (`Badhoevedorp-Sloterweg`) was 13 months stale while Luchtmeetnet had a current value.
- Luchtmeetnet carries pollutants OpenAQ does not have for these stations: soot (`FN`), black carbon from wood burning (`BCWB`), ultrafine particles (`PS`), benzene, toluene, xylene.
- Its measurement responses carry no unit, and `FN`, `BCWB` are not in its `/components` list. A station's coordinates need one call per station; a nationwide catalogue would exceed the rate limit on a cold start.

## Decision
1. **A sync pulls both sources and stores one merged layer.** The worker merges before the write; the browser never sees a duplicate or calls either source. Luchtmeetnet is only asked when the region's box overlaps its catalogue.
2. **Same station = within 50 m**, by distance alone (names differ between sources). A merged station keeps OpenAQ's name and point; per pollutant it takes the newer reading, Luchtmeetnet winning a tie, and only when both report the same unit. The distance is an **Assumption** from one city.
3. **Luchtmeetnet-only stations** are added. Each reading records its `source`; a station lists its `sources`.
4. **Units for Luchtmeetnet are a fixed table** (µg/m³ for gases, particulates, `FN`, `BCWB`, benzene, toluene, xylene; particles/cm³ for `PS`). This is an **Assumption** taken from component descriptions, not from the API.
5. **Station catalogue is a dated snapshot in the repo**, refreshed by a script, because coordinates cost one call per station. Latest values cost one call per station (no `formula` returns the newest hours of every pollutant).
6. **Partial success.** If Luchtmeetnet fails, the job still `succeeded` with OpenAQ's stations and a `warnings` entry; OpenAQ failing still fails the job. This resolves the "`partially_succeeded`" open item in `domain.md` as "succeeded with warnings".
7. Station history stays OpenAQ-only: a station without an OpenAQ location returns no points.

## Alternatives considered
- **Replace OpenAQ** — fewer stations (102 nationwide), no AirGradient sensors, and Netherlands-only.
- **Merge in the browser** — rejected by the maintainer: it moves de-duplication to every client.
- **Match by name** — misses `Zaanstad-Hoogtij` / `Amsterdam-Hoogtij` and `Amsterdam-Ookmeer` / `Amsterdam-Sportpark Ookmeer (Osdorp)`.
- **Live catalogue with a cache** — a cold start needs about 107 calls against a limit of 100 per 5 minutes.
- **Fail the sync when Luchtmeetnet fails** — a fair-use outage would block Dutch regions.

## Consequences
- New migration: `station_readings` gains `luchtmeetnet_number`, `sources`, a nullable `openaq_location_id`; `sync_jobs` gains `warnings`.
- The catalogue snapshot goes stale as stations open or close; a new station is missing until the script is rerun.
- Pollutants with no WHO table (`FN`, `BCWB`, `PS`, benzene) use the layer-relative colour ramp, not guideline classes.
- The 50-station cap applies to the merged result.
- Licence terms beyond "fair use" are unchecked; read RIVM's open-data page before showing this publicly.
- Luchtmeetnet gets its own time budget per sync (120 s, `AIRLAYER_LUCHTMEETNET_BUDGET_SECONDS`); past it the sync keeps OpenAQ's data and adds a warning. Its call limit is shared by all syncs in a process, so several workers add up to more than 100 per 5 minutes.
- A region holding more Luchtmeetnet stations than the cap fails with `too_many_stations` before any Luchtmeetnet call.
- Units are stored with the micro sign for both sources (OpenAQ sometimes sends the Greek mu), so one pollutant is one scale.
- One malformed Luchtmeetnet record (a future timestamp, a null value) fails the whole Luchtmeetnet fetch, so the sync carries a warning instead of that source's stations.
- On a merged station the history chart is OpenAQ-only, so it can disagree with a fresher Luchtmeetnet current value.
- Follow-up: Luchtmeetnet history for the trend chart; verifying units with RIVM; a periodic catalogue refresh.
