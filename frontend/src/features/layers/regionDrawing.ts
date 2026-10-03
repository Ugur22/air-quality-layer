import type { Map as MapLibreMap } from 'maplibre-gl'
import { TerraDraw, TerraDrawRectangleMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import type { Bbox } from '@/features/regions/types'

const DECIMALS = 4

function round(value: number): number {
  const factor = 10 ** DECIMALS
  return Math.round(value * factor) / factor
}

/** A map panned across the date line repeats the world; bring a longitude back into -180..180. */
function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

/**
 * [west, south, east, north] of a drawn rectangle's ring, rounded to the 4 decimals the form and
 * OpenAQ accept. The form's own validation then decides whether the box is usable.
 */
export function rectangleToBbox(ring: number[][]): Bbox {
  const lons = ring.map(([lon]) => wrapLongitude(lon ?? 0))
  const lats = ring.map(([, lat]) => lat ?? 0)
  return [
    round(Math.min(...lons)),
    round(Math.min(...lats)),
    round(Math.max(...lons)),
    round(Math.max(...lats)),
  ]
}

const STYLE = {
  fillColor: '#0a7570',
  fillOpacity: 0.15,
  outlineColor: '#0a7570',
  outlineWidth: 2,
} as const

/**
 * Lets the user drag one rectangle on the map (ADR 0011). When it is finished the box is handed
 * to `onFinish` and the drawn shape is removed: the app draws the region itself from the form
 * values, which stay the single source of truth. Returns a function that stops drawing.
 *
 * Pointer-only by nature; the form's number fields are the keyboard path. The unit tests replace
 * terra-draw, so that the library really draws, and that the map pans afterwards, is checked in a
 * real browser (e2e/drawing.spec.ts).
 */
export function startRectangleDrawing(
  map: MapLibreMap,
  onFinish: (bbox: Bbox) => void,
): () => void {
  // terra-draw switches map panning and rotating off for the length of a drag and only restores
  // them when the drag ends. Stopping in the middle of a drag (Escape) leaves them off for good,
  // so what the map had is put back whenever drawing stops.
  const hadDragPan = map.dragPan.isEnabled()
  const hadDragRotate = map.dragRotate.isEnabled()

  let draw: TerraDraw | null = null
  const begin = () => {
    const created = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map }),
      modes: [new TerraDrawRectangleMode({ drawInteraction: 'click-drag', styles: STYLE })],
    })
    created.on('finish', (id) => {
      const drawn = created.getSnapshot().find((feature) => feature.id === id)
      if (drawn?.geometry.type !== 'Polygon' || !drawn.geometry.coordinates[0]) return
      created.clear()
      const bbox = rectangleToBbox(drawn.geometry.coordinates[0])
      // A drag too small to be a box must not replace a good one with an empty box.
      if (bbox[0] < bbox[2] && bbox[1] < bbox[3]) onFinish(bbox)
    })
    created.on('ready', () => {
      created.setMode('rectangle')
    })
    created.start()
    draw = created
  }

  // The adapter adds sources and layers at once, which MapLibre refuses before the style has loaded.
  if (map.isStyleLoaded()) begin()
  else map.once('load', begin)

  return () => {
    map.off('load', begin)
    draw?.stop()
    draw = null
    if (hadDragPan) map.dragPan.enable()
    if (hadDragRotate) map.dragRotate.enable()
  }
}
