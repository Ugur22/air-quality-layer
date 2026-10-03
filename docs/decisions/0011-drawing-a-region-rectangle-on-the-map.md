# 0011. Drawing a region rectangle on the map

- Status: accepted
- Date: 2026-10-03

## Context
A region is a bounding box (`api-contracts.md` section 1). The form lets a user type four numbers; the user also wants to draw the rectangle on the map. ADR 0006 chose MapLibre GL through `react-map-gl` but did not choose a drawing tool. Facts checked on 2026-10-03:

- `terra-draw` (MIT, last published 2026-09-20) has a built-in `rectangle` mode (`TerraDrawRectangleMode`) with a `drawInteraction` option: `click-move` (default, two clicks), `click-drag`, or `click-move-or-drag`. It emits `finish` when a shape is complete.
- `terra-draw-maplibre-gl-adapter` (last published 2026-05-17) connects it to MapLibre. Its documentation lists MapLibre GL JS v4 and v5; npm's latest MapLibre is 6.11.2, so v6 compatibility is not documented. MapLibre 5.24.0 is the newest v5.
- `react-map-gl` 8 has a `react-map-gl/maplibre` entry point and gives access to the underlying MapLibre map object, which the adapter needs.
- The server accepts up to 4 decimal places in a bbox (OpenAQ truncates more) and rejects boxes over 2 degrees per side (`schemas.py`).

## Decision
Use **terra-draw** with its MapLibre adapter and the `rectangle` mode in `click-drag` interaction. A finished rectangle writes its four coordinates, rounded to 4 decimals, into the existing form fields; the form stays the single source of truth, and the numeric fields remain as the keyboard and screen-reader path. Existing client validation applies to a drawn box exactly as to a typed one (a box over 2 degrees shows the same error). Pin `maplibre-gl` to the v5 line (`^5.24`) until the adapter documents v6.

## Alternatives considered
- **Custom drawing with MapLibre pointer events** — no new dependency, and a single rectangle needs little code, but we would own touch input, cancelling with Escape, disabling map dragging while drawing, and drawing preview. Rejected because a maintained mode covers these.
- **`@mapbox/mapbox-gl-draw`** — widely used, but built around Mapbox GL; to my knowledge it has no built-in rectangle mode, so it would need an extra plugin. Not verified against MapLibre 5; not pursued.
- **MapLibre v6 now** — newest, but the adapter's documented range stops at v5, and a drawing bug found only in a real browser is costly. Revisit when the adapter lists v6.

## Consequences
- Adds two dependencies (`terra-draw`, `terra-draw-maplibre-gl-adapter`). Their bundle size has not been measured.
- Drawing is pointer behaviour on a WebGL map: jsdom cannot exercise it. It is verified only in a real browser, by hand and by the Playwright test (ADR 0009); unit tests cover the form it fills, not the drawing.
- Drawing must not be the only way in: the numeric fields stay.
- Pinning v5 means a later move to v6 is a deliberate step with its own check.
- deck.gl remains deferred as ADR 0006 says. It can be added later next to MapLibre (through `@deck.gl/mapbox`) without changing this decision.
