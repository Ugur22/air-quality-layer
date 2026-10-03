# 0015. Guideline-based marker colours instead of a layer-relative ramp

- Status: accepted
- Date: 2026-10-03

## Context
Station markers are coloured by a 3-stop teal ramp stretched between the layer's own minimum and maximum (`mapData.ts`, `COLOUR_STOPS`), and the legend says "relative to this layer". The darkest marker therefore means "highest on screen", not "high". A layer where every station reads 3 to 5 µg/m³ paints the 5 as the darkest, and a layer reading 80 to 90 paints the 80 as the lightest. Green-to-dark-green also reads as "healthy", so the most polluted station looks the most benign. ColorBrewer's guidance is that sequential schemes (such as BuGn) suit ordered data with no critical threshold; air quality has one.

`product.md` lists "no AQI index computation" and "no thresholds that trigger anything" as non-goals, and leaves the AQI formula **Open**. This decision adds neither an index nor any trigger: it only chooses reference levels for colouring one reading at a time.

## Decision
1. **Colour a marker by absolute class, not by layer range.** Classes come from a per-pollutant breakpoint table in the frontend, applied with a MapLibre `case` expression on inclusive upper bounds (a value exactly on a boundary stays in the lower class, which `step` would not do). No API or schema change.
2. **Reference levels are the WHO 2021 air quality guideline (24-hour) and its interim targets**, because they are published per pollutant, in µg/m³, without sub-index arithmetic. First table: `pm25`, `pm10`, `no2`. Where a pollutant has more interim targets than colours, one is left out (pm25: 37.5, pm10: 50). Other pollutants are added only once their levels and units are checked against the WHO source.
3. **Classed, escalating hue (yellow to dark red), with a discrete legend** showing each class and its numeric range. The first class is the one at or below the guideline level. A class label is always shown with the colour so colour is never the only cue.
4. **A pollutant with no table, or a reading in an unexpected unit, falls back to the existing relative ramp** and the legend keeps saying "relative to this layer".
5. The product copy calls the classes "against WHO 2021 guideline levels", never "safe" or "unsafe", and not an AQI.
6. **The station dialog uses the same classes** (added 2026-10-03, same table, no new data): the overview shows the value's class, bands behind the strip plot, class-coloured dots and class-coloured reading bars (absolute scale, full at the top class bound); the trend shows the bands, a dashed guideline line, a y-axis that always reaches twice the guideline level, and a class-coloured latest point. Each chart carries a key that says the bands are 24-hour levels while the points are hourly. Pollutants without a table keep the teal, relative look.

## Alternatives considered
- **EU EAQI or US EPA AQI** — familiar colours, but both compute per-pollutant sub-indices with their own averaging windows; that is the Open AQI decision and a larger change.
- **EU limit values** — legal rather than health-based, and looser than WHO; one level per pollutant gives too few classes.
- **Keep the relative ramp, fix the colours** — still cannot answer "is this high?", which is the question.
- **Diverging ramp around the guideline** — implies a meaningful "below" side; being under the guideline is not a second hazard direction.

## Consequences
- The map answers "how does this compare to the guideline", and the same colour means the same thing in every region and on every day.
- WHO levels are 24-hour means; stored readings are the latest hourly value. A single hourly reading can exceed a 24-hour level without the day doing so. The legend and copy must say "latest reading", and this mismatch is the main risk of the approach.
- Breakpoint values are a table to be checked against the WHO source before they are accepted, and they are a starting set.
- The tests that pin the old ramp (`mapData.test.ts`) change with the paint function.
- If accepted, update `product.md` (state that guideline-class colouring is in scope and the AQI stays Open) and `quality.md` if it names the colour rule.
