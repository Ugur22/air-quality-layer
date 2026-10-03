# 0016. Value badges on a quiet basemap

- Status: accepted
- Date: 2026-10-03

## Context
With ADR 0015's yellow-to-red classes on OpenFreeMap's `liberty` style, the markers lost to the basemap: the palest class matched the road fill, the orange classes matched motorway casing, and every station was a dot plus a separate floating number. Stations without a value were hollow rings with a "–", as visible as real readings, and a stale reading was a 45%-opacity dot that nearly vanished on pale ground.

## Decision
1. **Default basemap is OpenFreeMap `positron`** (light, desaturated, same host, no key, same `Noto Sans` glyphs), so the class colours are the only saturated colour on the map. `VITE_BASEMAP_STYLE_URL` still overrides it. This changes only the default named in ADR 0008.
2. **A station with a value is a value badge**: a pill filled with its class colour with the number inside, drawn from one SDF image registered at map load (`badgeImage.ts`) and tinted per feature. A second, slightly larger pill underneath is the border. No badge is hidden by collisions. A symbol layer draws all pills and then all numbers, so overlapping badges can overprint their numbers. To keep that out of the zoomed-out view, badges only show from zoom 11 (`BADGE_MIN_ZOOM`); below it a station with a value is a plain dot in the same colour, with no number, and the highest value is drawn on top. Overprinting can still happen between close stations at zoom 11 to 13.
3. **A station without a usable value is a small grey dot** with no label. It stays clickable and gets the same selection ring; the tooltip and list carry the detail.
4. **A stale reading** is the class colour mixed with white (opaque, so dark text stays legible) with a grey border. Legend text says "pale badge".
5. **Text colour** is white on the darkest class (or the top third of a relative ramp) and dark ink elsewhere. Dark ink on the second-darkest class (`#f03b20`) is about 4.3:1, just under AA; white is lower still, so it stays dark.
6. The classes, breakpoints and WHO wording of ADR 0015 are unchanged.

## Alternatives considered
- **Keep `liberty`, change the palette** — would reopen ADR 0015 and still fight a busy basemap.
- **Interpolated surface or heatmap** — implies measurements between stations that do not exist.
- **Dashed outline for stale** — SDF tinting cannot draw a second colour or a dash; a pale fill with a grey border carries the same message.
- **Clustering** — not needed at current region sizes.

## Consequences
- Pixel output is only verified in a real browser (`make e2e`); jsdom tests check the layer expressions and that the image is registered before the layers that name it.
- The badge layers mount after the style loads. A style swap at runtime would need the image re-added.
- The legend and tooltips no longer mention rings; the "other unit" station is a grey dot.
