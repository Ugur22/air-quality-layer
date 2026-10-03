# 0007. Backend framework, database, and local development

- Status: accepted
- Date: 2026-10-02

## Context
AirLayer needs an API framework, a spatial-capable database, and a local development setup, for the same shape of system Layerline already validated: an async Python API plus a background worker, both talking to one Postgres instance.

## Decision
- **API framework:** FastAPI, JSON over HTTP, with the OpenAPI schema as the contract's machine-readable form.
- **Database:** PostgreSQL with PostGIS. Geometry columns carry an explicit SRID (WGS84 / EPSG:4326, matching OpenAQ's coordinates).
- **Local development:** Docker Compose runs the database, API and worker. A fresh clone must start the stack with one command.

## Alternatives considered
- Django/DRF — heavier than needed, less natural for an async, typed API; rejected in Layerline for the same reason.
- SQLite/SpatiaLite — simpler setup, but weaker spatial features.
- Host-installed services without Docker — fragile setup and no parity between machines.

## Consequences
- Integration tests run against a real PostGIS container, not a mock.
- Compose files are project code and are reviewed like any other change.
- Uses the same community multi-arch PostGIS image Layerline uses (`imresamu/postgis`), since the official image has no arm64 build; revisit if an official arm64 build appears or before any deployment.
- Unlike Layerline, there is no file-storage volume: ingestion reads from OpenAQ over HTTP, not from an uploaded file (ADR 0002).
