# 0012. MapLibre 6 with an explicit worker URL

- Status: accepted
- Date: 2026-10-03

## Context
ADR 0011 said to pin `maplibre-gl` to the v5 line so it matches the documented range of the drawing adapter. While installing it, `npm audit` reported a critical advisory: GHSA-jrc7-96c5-q579 (CVE-2026-85061, CVSS 10.0), a zero-click XSS through `DOM.sanitize()` in MapLibre's attribution handling, affecting every version up to 6.4.0. The advisory names 6.4.1 as the fix and documents no fix for 5.x. The basemap style, and so its attribution text, comes from a third party (ADR 0008), and its URL is configurable.

MapLibre 6 also finds its web worker through a URL the bundler cannot see. In a real browser the map was blank with "Worker failed to load", in dev and in `vite build`; `optimizeDeps.exclude` only hid it in dev. Neither failure is visible to typecheck, lint, build or jsdom tests.

## Decision
Use `maplibre-gl` 6.4.1 or later (6.11.2 installed), superseding only the "pin to v5" sentence of ADR 0011; the rest of ADR 0011 (terra-draw, click-drag rectangle, form as source of truth) stands. Register the worker explicitly: import `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and call `setWorkerUrl` once from `main.tsx` (`src/lib/mapWorker.ts`). Before the drawing slice, check `terra-draw-maplibre-gl-adapter` against MapLibre 6 in a real browser; if it does not work, bring that back as a decision instead of downgrading to a vulnerable version.

## Alternatives considered
- **Stay on 5.x as ADR 0011 said** — no fix is documented for 5.x, so this would knowingly ship a critical XSS.
- **Serve the worker from `public/`** — works, but needs a copy step that can drift from the installed version.
- **`optimizeDeps.exclude`** — fixes the dev server only.

## Consequences
- Adapter compatibility with MapLibre 6 is unverified until the drawing slice (the adapter documents v4 and v5).
- The map must be verified in a real browser on both the dev server and a production build; the worker problem passed every non-browser check.
- Run `npm audit` when adding map dependencies; it found this.
