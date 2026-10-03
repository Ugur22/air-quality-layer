# 0009. Playwright for end-to-end tests

- Status: accepted
- Date: 2026-10-02

## Context
The first vertical slice (define a region → sync → map layer) crosses the whole stack and includes MapLibre rendering, which jsdom cannot exercise (`docs/quality.md`). Layerline already validated an end-to-end runner for the same kind of flow.

## Decision
Playwright, same as Layerline ADR 0010, carried over unchanged. One end-to-end test per vertical slice, run against the real Compose stack.

## Alternatives considered
- Cypress — comparable capability; Playwright was already proven in the sibling project with no reported friction.
- No end-to-end coverage, unit/integration only — rejected: the map and its worker are only verifiable in a real browser.

## Consequences
- `make e2e` needs `make up` first and starts its own frontend dev server, same pattern as Layerline.
- End-to-end tests are the only verification for MapLibre-dependent behaviour; this must be stated explicitly in any report that touches the map.
