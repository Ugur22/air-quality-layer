# 0006. Map stack

- Status: accepted
- Date: 2026-10-02

## Context
The frontend needs to render a region's station readings as points on a map, with hover/click inspection and property-based styling (colour by pollutant level). Layerline already validated a map stack for rendering point features from a backend-provided layer.

## Decision
MapLibre GL via `react-map-gl`, same as Layerline ADR 0006, carried over unchanged. deck.gl is deferred until a measured need for large-layer rendering exists (unlikely at single-region, single-sync scale).

## Alternatives considered
- Leaflet — simpler API, weaker at styled/data-driven point rendering than MapLibre's expression-based styling, which AirLayer needs for colouring stations by pollutant value.
- Google Maps / Mapbox GL JS — licensing/cost concerns for a portfolio project meant to be run and shown freely.

## Consequences
- Same MapLibre worker-lifecycle caveats Layerline hit apply here (jsdom cannot exercise it; verify map behaviour only via `make e2e`, per `docs/quality.md`).
- Basemap tile source is a separate decision (ADR 0008).
