# 0008. Basemap tile source

- Status: accepted
- Date: 2026-10-02

## Context
MapLibre (ADR 0006) needs a basemap style URL for local development. Layerline already resolved this for the same kind of app.

## Decision
A configurable basemap style URL (`VITE_BASEMAP_STYLE_URL`), defaulting to OpenFreeMap's hosted style (`https://tiles.openfreemap.org/styles/liberty`) for local development, same as Layerline ADR 0009. No API key required for the default.

## Alternatives considered
- Mapbox-hosted styles — requires an API key and has usage-based pricing; unnecessary for local development.
- Self-hosting tiles — unneeded operational burden at this stage.

## Consequences
- Re-check OpenFreeMap's terms before using this beyond local development or showing the project publicly at scale.
- Switching providers later is a config change, not a code change.
