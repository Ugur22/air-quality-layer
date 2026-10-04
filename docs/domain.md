# Domain vocabulary

Shared terms for code, API, UI copy, and docs. Use these names exactly; do not introduce synonyms (e.g. "station" for monitoring location in one place and "sensor" in another — see the distinction below). Status: **Assumption** until an ADR or implementation confirms.

## Terms

| Term | Definition |
|---|---|
| **Organisation** | Top-level owner of projects and the boundary for access control. |
| **Project** | A named workspace within an organisation grouping related regions. |
| **Region** | A named area of interest within a project, defined by a bounding box, that AirLayer pulls air-quality data for. The pull-based analogue of Layerline's "dataset". |
| **Sync job** | One attempt to pull data (OpenAQ, and Luchtmeetnet for Dutch regions, ADR 0017) for a region's bounding box and write station readings. Has a status and, on failure, errors; a succeeded job can carry warnings. Immutable record once finished. The pull-based analogue of Layerline's "import job". |
| **Map layer** | A renderable, read-oriented view of a region's current station readings (name, feature count, style hints). |
| **Station reading** | One monitoring station's geometry plus its pollutant parameter values at sync time (e.g. a GeoJSON-like point with a `{ "pm25": 12.4, "no2": 8.1 }` property map). The unit of storage and display. It records its source sync job. |
| **Audit event** | An append-only record of who did what to which entity and when. |

## Relationships

```
Organisation 1 ── * Project 1 ── * Region
Region 1 ── * SyncJob          (each job pulls data for one region)
Region 1 ── * MapLayer         (Open: 1:1 or 1:many in the first slice)
Region 1 ── * StationReading   (created by sync jobs; each reading records its source job)
AuditEvent * ── 1 Organisation (references the affected entity by type + id)
```

## Sync job statuses (Assumption)

`queued` → `processing` → `succeeded` | `failed`. Terminal states do not change. Whether `cancelled` exists is **Open**. A sync is all-or-nothing for OpenAQ, but a succeeded job can carry `warnings` when the optional second source (Luchtmeetnet) could not be used (ADR 0017, proposed); no `partially_succeeded` status exists.

## Rules

- Every entity belongs to exactly one organisation, directly or through its parent.
- A station reading is only visible in a layer if its sync job succeeded.
- Audit events are never updated or deleted by application code.
- Identifiers are opaque to clients and are UUIDs (ADR 0010).
- Stations of different sources within 50 m are one station (ADR 0017). A station's identity across syncs is OpenAQ's location id, or the Luchtmeetnet number for a station only that source has, not AirLayer's reading id; re-syncing the same region does not imply the same station reading row (see open question below).

## Open questions

Answered by ADR 0010 (accepted):

- Does re-syncing a region replace, append, or version its station readings? Decided: none of these; each succeeded sync job owns its own readings and earlier jobs are untouched.
- Are map layers stored entities or derived on request? Decided: derived from one succeeded sync job (`map_layer_id` = sync job id).
- Does a station reading store every OpenAQ parameter it has, or only a configured subset per region? Decided: every parameter OpenAQ returns.
- Is a station reading "latest value per parameter" (a snapshot) or does AirLayer ever store a short history per station? Decided: snapshot only; each parameter carries `value`, `unit`, `observed_at`.
- Identifiers: UUID (opaque to clients).
- Sync job at most one `queued`/`processing` per region (decided); `timed_out` for jobs abandoned by a dead worker (decided).
