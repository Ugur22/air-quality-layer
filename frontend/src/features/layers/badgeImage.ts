import type { Map as MapLibreMap } from 'maplibre-gl'
import { BADGE_IMAGE, GUIDELINE_COLOURS, staleBadgeImage } from './mapData'

// A pill drawn as a signed distance field, so `icon-color` can tint it and `icon-text-fit` can
// stretch it around any number. MapLibre reads the edge at alpha 0.75 and fades out over `RADIUS` px.
const RADIUS = 8
const SIZE = 40
const INSET = RADIUS
const ROUND = (SIZE - 2 * INSET) / 2

/** Signed distance to the pill's edge in image pixels: negative inside, positive outside. */
function pillDistance(x: number, y: number): number {
  const half = SIZE / 2
  // Distance to the rounded square of half-size `half - INSET` with corner radius `ROUND`;
  // with the corner radius equal to the half-size the shape is a circle, which stretches to a pill.
  const dx = Math.abs(x + 0.5 - half) - (half - INSET - ROUND)
  const dy = Math.abs(y + 0.5 - half) - (half - INSET - ROUND)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - ROUND
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside
}

export function badgePixels(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const alpha = Math.round(255 * Math.min(1, Math.max(0, 0.75 - pillDistance(x, y) / RADIUS)))
      data[(y * SIZE + x) * 4 + 3] = alpha
    }
  }
  return { width: SIZE, height: SIZE, data }
}

// A stale reading is a hollow badge: an opaque white pill with a ring in its class colour and the
// same ink edge a current badge has. It is drawn in full colour here, not as an SDF, because an SDF
// has one fill and one halo and cannot hold white inside, a class colour and ink outside. It is
// opaque so the station's dot underneath does not show through it. Sizes are image pixels (2 per
// CSS pixel); the ink edge matches the 1.5 image px halo a current badge draws outside its edge.
const EDGE = 1.5
const INK_WIDTH = 1.5
const RING_WIDTH = 3
const INK = [0x12, 0x20, 0x1f] as const
const WHITE = [255, 255, 255] as const

const parseHex = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/** How far past a boundary a pixel is, from 0 (before it) to 1 (a pixel beyond), for 1 px of antialiasing. */
const past = (distance: number, boundary: number) =>
  Math.min(1, Math.max(0, distance - boundary + 0.5))

export function staleBadgePixels(colour: string): {
  width: number
  height: number
  data: Uint8ClampedArray
} {
  const ring = parseHex(colour)
  const data = new Uint8ClampedArray(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = pillDistance(x, y)
      const toRing = past(d, EDGE - INK_WIDTH - RING_WIDTH)
      const toInk = past(d, EDGE - INK_WIDTH)
      const at = (y * SIZE + x) * 4
      for (let c = 0; c < 3; c++) {
        const inner = (WHITE[c] ?? 0) + ((ring[c] ?? 0) - (WHITE[c] ?? 0)) * toRing
        data[at + c] = Math.round(inner + ((INK[c] ?? 0) - inner) * toInk)
      }
      data[at + 3] = Math.round(255 * (1 - past(d, EDGE)))
    }
  }
  return { width: SIZE, height: SIZE, data }
}

/** Registers the pill once the style is loaded; the centre column and row are what stretches. */
export function addBadgeImage(map: MapLibreMap): void {
  if (map.hasImage(BADGE_IMAGE)) return
  const mid = SIZE / 2
  const stretch = {
    pixelRatio: 2,
    stretchX: [[mid - 1, mid + 1]] as [number, number][],
    stretchY: [[mid - 1, mid + 1]] as [number, number][],
    content: [INSET, INSET, SIZE - INSET, SIZE - INSET] as [number, number, number, number],
  }
  map.addImage(BADGE_IMAGE, badgePixels(), { ...stretch, sdf: true })
  for (const colour of GUIDELINE_COLOURS) {
    map.addImage(staleBadgeImage(colour), staleBadgePixels(colour), stretch)
  }
}
