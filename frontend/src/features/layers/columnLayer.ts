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

export const COLUMN_PITCH = 55
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

/** Metres across the diagonal of the box the columns have to read against. */
function diagonalMetres([w, s, e, n]: [number, number, number, number]): number {
  const dy = (n - s) * 111_320
  const dx = (e - w) * 111_320 * Math.cos((((n + s) / 2) * Math.PI) / 180)
  return Math.hypot(dx, dy)
}

export interface ColumnLayerInput {
  data: MapStationCollection
  range: ValueRange | null
  property: string | null
  bbox: [number, number, number, number]
  selectedId: string | null
}

/**
 * Height is the value, so it is always zero-based: a column twice as tall is a reading twice as
 * high. Size is relative to the region box so the same view works for a city or a province.
 */
export function buildColumnLayers({ data, range, property, bbox, selectedId }: ColumnLayerInput) {
  const diagonal = diagonalMetres(bbox)
  const radius = Math.max(diagonal * 0.008, 40)
  const heightScale = range && range.max > 0 ? (diagonal * 0.12) / range.max : 0
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
      getFillColor: EMPTY_FILL,
      radiusMinPixels: 4,
    }),
    new ColumnLayer<Station>({
      id: 'columns-selected',
      data: selected,
      getPosition: position,
      radius: radius * 1.7,
      diskResolution: 24,
      extruded: true,
      getElevation: (s) => (s.properties.value ?? 0) * heightScale,
      getFillColor: SELECTED_FILL,
      material: false,
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
        return [...rgbColour, s.properties.stale ? STALE_ALPHA : 255] as Rgba
      },
      updateTriggers: { getFillColor: [range, property], getElevation: [heightScale] },
    }),
  ]
}
