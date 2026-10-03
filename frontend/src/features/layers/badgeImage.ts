import type { Map as MapLibreMap } from 'maplibre-gl'
import { BADGE_IMAGE } from './mapData'

// A pill drawn as a signed distance field, so `icon-color` can tint it and `icon-text-fit` can
// stretch it around any number. MapLibre reads the edge at alpha 0.75 and fades out over `RADIUS` px.
const RADIUS = 8
const SIZE = 40
const INSET = RADIUS
const ROUND = (SIZE - 2 * INSET) / 2

export function badgePixels(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4)
  const half = SIZE / 2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Distance to the rounded square of half-size `half - INSET` with corner radius `ROUND`;
      // with the corner radius equal to the half-size the shape is a circle, which stretches to a pill.
      const dx = Math.abs(x + 0.5 - half) - (half - INSET - ROUND)
      const dy = Math.abs(y + 0.5 - half) - (half - INSET - ROUND)
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - ROUND
      const inside = Math.min(Math.max(dx, dy), 0)
      const distance = outside + inside
      const alpha = Math.round(255 * Math.min(1, Math.max(0, 0.75 - distance / RADIUS)))
      data[(y * SIZE + x) * 4 + 3] = alpha
    }
  }
  return { width: SIZE, height: SIZE, data }
}

/** Registers the pill once the style is loaded; the centre column and row are what stretches. */
export function addBadgeImage(map: MapLibreMap): void {
  if (map.hasImage(BADGE_IMAGE)) return
  const mid = SIZE / 2
  map.addImage(BADGE_IMAGE, badgePixels(), {
    sdf: true,
    pixelRatio: 2,
    stretchX: [[mid - 1, mid + 1]],
    stretchY: [[mid - 1, mid + 1]],
    content: [INSET, INSET, SIZE - INSET, SIZE - INSET],
  })
}
