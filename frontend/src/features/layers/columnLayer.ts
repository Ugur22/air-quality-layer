import { ColumnLayer, ScatterplotLayer } from '@deck.gl/layers'
import {
  classOf,
  COLOUR_STOPS,
  guidelineClasses,
  type MapStationCollection,
  type ValueRange,
} from './mapData'

type Rgba = [number, number, number, number]
type Station = MapStationCollection['features'][number]

export const COLUMN_PITCH = 45
const STALE_ALPHA = 140
const EMPTY_FILL: Rgba = [180, 192, 190, 255]
const SELECTED_FILL: Rgba = [10, 117, 112, 170]

function rgb(hex: string): [number, number, number] {
  const n = (i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  return [n(0), n(1), n(2)]
}

/** Same colour rule as the badges: the WHO class, or the layer-relative ramp when there is none. */
function columnColour(
  value: number,
  range: ValueRange,
  property: string | null,
): [number, number, number] {
  const classes = guidelineClasses(property, range.unit)
  const hit = classOf(classes, value)
  if (hit) return rgb(hit.colour)
  const [low, mid, high] = COLOUR_STOPS.map(rgb) as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ]
  const span = range.max - range.min
  if (span <= 0) return mid
  const t = (value - range.min) / span
  const [from, to, local] = t < 0.5 ? [low, mid, t * 2] : [mid, high, (t - 0.5) * 2]
  return [0, 1, 2].map((i) =>
    Math.round((from[i] ?? 0) + ((to[i] ?? 0) - (from[i] ?? 0)) * local),
  ) as [number, number, number]
}

/** Ground metres under one screen pixel at this zoom and latitude (MapLibre's 512px tiles). */
export function metresPerPixel({ zoom, latitude }: MapView): number {
  return (78_271.517 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom
}

/** Columns are sized in screen pixels, so zooming in separates stations that overlapped before. */
const COLUMN_RADIUS_PX = 6
const COLUMN_MAX_HEIGHT_PX = 110

export interface MapView {
  zoom: number
  latitude: number
}

export interface ColumnLayerInput {
  data: MapStationCollection
  range: ValueRange | null
  property: string | null
  view: MapView
  selectedId: string | null
  /** False draws every column fully transparent; flipping it to true fades them in. */
  grown: boolean
}

const FADE = { duration: 400 }

/**
 * Height is the value, so it is always zero-based: a column twice as tall is a reading twice as
 * high. Size follows the map zoom, so the same view works for a street, a city or a country.
 */
export function buildColumnLayers({
  data,
  range,
  property,
  view,
  selectedId,
  grown,
}: ColumnLayerInput) {
  const metres = metresPerPixel(view)
  const radius = metres * COLUMN_RADIUS_PX
  const heightScale = range && range.max > 0 ? (metres * COLUMN_MAX_HEIGHT_PX) / range.max : 0
  const shown = (alpha: number) => (grown ? alpha : 0)
  const position = (s: Station) => s.geometry.coordinates
  const valued = data.features.filter((s) => s.properties.hasValue && s.properties.value !== null)
  const empty = data.features.filter((s) => !s.properties.hasValue)
  const selected = valued.filter((s) => s.properties.id === selectedId)

  return [
    new ScatterplotLayer<Station>({
      id: 'columns-empty',
      data: empty,
      pickable: true,
      getPosition: position,
      getRadius: radius,
      getFillColor: [EMPTY_FILL[0], EMPTY_FILL[1], EMPTY_FILL[2], shown(EMPTY_FILL[3])],
      transitions: { getFillColor: FADE },
      radiusMinPixels: 4,
    }),
    new ColumnLayer<Station>({
      id: 'columns-selected',
      data: selected,
      getPosition: position,
      radius: radius * 1.7,
      diskResolution: 24,
      extruded: true,
      // Lower than the station's own column, so the halo reads as a collar and the column keeps
      // its class colour instead of being painted over.
      getElevation: (s) => (s.properties.value ?? 0) * heightScale * 0.8,
      getFillColor: [SELECTED_FILL[0], SELECTED_FILL[1], SELECTED_FILL[2], shown(SELECTED_FILL[3])],
      material: false,
      transitions: { getFillColor: FADE },
      updateTriggers: { getElevation: [heightScale] },
    }),
    new ColumnLayer<Station>({
      id: 'columns',
      data: valued,
      pickable: true,
      getPosition: position,
      radius,
      diskResolution: 24,
      extruded: true,
      getElevation: (s) => (s.properties.value ?? 0) * heightScale,
      getFillColor: (s) => {
        const rgbColour = range
          ? columnColour(s.properties.value ?? 0, range, property)
          : EMPTY_FILL
        return [...rgbColour, shown(s.properties.stale ? STALE_ALPHA : 255)] as Rgba
      },
      transitions: { getFillColor: FADE },
      updateTriggers: { getFillColor: [range, property, grown], getElevation: [heightScale] },
    }),
  ]
}
