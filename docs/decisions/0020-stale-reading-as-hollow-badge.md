# 0020. A stale reading is a hollow badge

- Status: proposed
- Date: 2026-10-04

## Context
ADR 0016 §4 draws a stale reading (24 hours old or older) as its class colour mixed 60% with white, with a grey border. On the default light basemap that tint is close to the colour of a lower class, so a stale station can pass for a current one of another class; it only shows as stale in the tooltip. Fading the whole marker with opacity was tried in this session and rejected on review: over the near-white basemap it measures about the same as the tint, it drops the number below AA contrast, and the station's dot shows through a translucent badge. ADR 0016 had already dropped an opacity-based stale dot for vanishing on pale ground.

## Decision
A stale reading is a **hollow badge**: an opaque white pill with a ring in its class colour and the same ink edge a current badge has, with dark ink text (its ink edge is as thick as the current badge's halo). The shape differs, so staleness no longer depends on telling two nearby colours apart, and the class is still read from the ring.
- With a class table (ADR 0015) the hollow badge is a full-colour image per class colour, registered at map load next to the current SDF pill (`badgeImage.ts`). An SDF has one fill and one halo, so it cannot hold white, a class colour and ink at once. The image is opaque, so the dot underneath does not show through. MapLibre cannot mix SDF and non-SDF icons in one layer, so stale readings are a layer of their own (`stations-stale`) drawn under the current badges, which therefore win collisions.
- Without a class table the colour comes from a continuous ramp that cannot be baked, so a stale reading is the current pill drawn white with the ramp colour as its outline (no ink edge).
- A stale **dot** is white with a class-coloured ring and a thin ink edge layer.
- 3D columns keep their class colour and fade to about 55%. Extruded geometry has no hollow form.
- Legend text changes from "pale badge" to "hollow badge", and says columns fade instead.

This replaces ADR 0016 §4 only. The 24-hour threshold, badge collision, dots and text colours of the other sections are unchanged.

## Alternatives considered
- **Fade the whole marker (opacity)** — built and reviewed; no better than the tint on a light basemap, unreadable text, dot shows through.
- **Dashed outline** — an SDF halo cannot be dashed, and a 1.5 px dash is faint on a 21 px pill.
- **Age written on the badge ("31 · 3d")** — explains the most, but widens every stale badge and so causes more collisions, and a dot cannot carry it. Still possible on top of this decision.
- **Keep the tint** — does not solve the confusion with lower classes.

## Consequences
- Five baked images plus the SDF pill are registered at load; a style swap at runtime must re-add all of them.
- The ring is about 1.5 px on screen. The palest class (`#ffffb2`) has little contrast against the basemap, so its hollow badge relies on the ink edge; check it in a browser.
- The hollow badge is white inside, so on a dark basemap (`VITE_BASEMAP_STYLE_URL`) it would stand out strongly.
- Pixel output is only verified in a real browser (ADR 0016 Consequences); unit tests cover the expressions, the image pixels and that every class has an image.
- After acceptance, ADR 0016's status becomes "superseded by 0020 for §4".
