import type { CircleLayerSpecification, SymbolLayerSpecification } from 'maplibre-gl'
import { formatValue } from '@/lib/format'
import { isStale } from '@/lib/freshness'
import type { StationFeature } from './types'

export interface MapStationProperties {
  id: string
  name: string
  hasValue: boolean
  value: number | null
  /** What is written next to the marker: the value, or an en dash when there is none. */
  label: string
  stale: boolean
}

export interface MapStationCollection {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: MapStationProperties
  }[]
}

export interface ValueRange {
  min: number
  max: number
  unit: string
  /** Stations reporting this parameter in a different unit; they are left off the scale. */
  otherUnitCount: number
}

export const NO_VALUE_LABEL = '–'

/** pm25 is the most commonly reported pollutant; otherwise the first one the layer has. */
export function pickColourProperty(propertyKeys: string[]): string | null {
  if (propertyKeys.includes('pm25')) return 'pm25'
  return propertyKeys[0] ?? null
}

/**
 * One flat record per station for the chosen property. Map styles read feature properties as flat
 * values, so the nested `readings` object cannot be styled directly. Staleness is that reading's
 * own age: a station can be current for one pollutant and months old for another.
 */
export function buildMapData(
  stations: StationFeature[],
  property: string | null,
  now: Date,
  /** The stations the colour scale (and its unit) is taken from; the whole layer when filtering. */
  scaleFrom: StationFeature[] = stations,
): MapStationCollection {
  const unit = valueRange(scaleFrom, property)?.unit
  return {
    type: 'FeatureCollection',
    features: stations.map((station) => {
      const found = property === null ? undefined : station.properties.readings[property]
      // A reading in another unit cannot share this colour scale, so it is shown as a hollow ring.
      const reading = found?.unit === unit ? found : undefined
      return {
        type: 'Feature',
        geometry: station.geometry,
        properties: {
          id: station.id,
          name: station.properties.name,
          hasValue: reading !== undefined,
          value: reading?.value ?? null,
          label: reading === undefined ? NO_VALUE_LABEL : formatValue(reading.value),
          stale: reading !== undefined && isStale(reading.observed_at, now),
        },
      }
    }),
  }
}

/** The scale uses the most common unit for the parameter (ties go to the unit seen first). */
export function valueRange(stations: StationFeature[], property: string | null): ValueRange | null {
  if (property === null) return null
  const readings = stations.flatMap((s) => {
    const reading = s.properties.readings[property]
    return reading ? [reading] : []
  })
  const counts = new Map<string, number>()
  for (const r of readings) counts.set(r.unit, (counts.get(r.unit) ?? 0) + 1)
  let unit: string | undefined
  for (const [candidate, count] of counts) {
    if (unit === undefined || count > (counts.get(unit) ?? 0)) unit = candidate
  }
  if (unit === undefined) return null
  const values = readings.filter((r) => r.unit === unit).map((r) => r.value)
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    unit,
    otherUnitCount: readings.length - values.length,
  }
}

/** Low to high on one hue. The scale is relative to this layer; it is not an air-quality index. */
export const COLOUR_STOPS = ['#cfe8e4', '#2f9c93', '#07403d'] as const

/** ColorBrewer YlOrRd, 5 classes: hue escalates, so the top class cannot read as benign. */
export const GUIDELINE_COLOURS = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'] as const

/**
 * Upper bounds (inclusive) of each class below the last, in µg/m³: the WHO 2021 24-hour guideline
 * level, then interim targets. To fit five colours one target is left out (pm25: 37.5, pm10: 50),
 * so a class position is not the same interim target across pollutants (ADR 0015). The stored value
 * is the latest hourly reading, so a class describes that reading, not a 24-hour mean.
 */
const GUIDELINE_BREAKS: Record<string, readonly number[]> = {
  pm25: [15, 25, 50, 75],
  pm10: [45, 75, 100, 150],
  no2: [25, 50, 120],
}

export interface GuidelineClass {
  colour: string
  label: string
  /** Exclusive lower bound of the class; 0 for the first. */
  from: number
  /** Inclusive upper bound of the class; Infinity for the last. */
  upTo: number
}

/** OpenAQ spells the unit with either the micro sign or the Greek mu. */
const isMicrogramsPerCubicMetre = (unit: string) => unit.replace('μ', 'µ') === 'µg/m³'

/** Fewer classes than colours skip the second-to-last step, so the top class stays the darkest. */
function coloursFor(count: number): string[] {
  const [darkest] = GUIDELINE_COLOURS.slice(-1)
  return count >= GUIDELINE_COLOURS.length
    ? [...GUIDELINE_COLOURS]
    : [...GUIDELINE_COLOURS.slice(0, count - 1), darkest ?? NO_FILL]
}

/** The classes for a pollutant, or null when there is no table or the unit is not µg/m³. */
export function guidelineClasses(property: string | null, unit: string): GuidelineClass[] | null {
  const breaks = property === null ? undefined : GUIDELINE_BREAKS[property]
  if (breaks === undefined || !isMicrogramsPerCubicMetre(unit)) return null
  const colours = coloursFor(breaks.length + 1)
  return [...breaks, Infinity].map((upTo, i) => {
    const lower = breaks[i - 1]
    const label =
      lower === undefined
        ? `≤ ${formatValue(upTo)}`
        : upTo === Infinity
          ? `> ${formatValue(lower)}`
          : `${formatValue(lower)}–${formatValue(upTo)}`
    return { colour: colours[i] ?? '', label, from: lower ?? 0, upTo }
  })
}

/** The class a value falls in; a value on a boundary belongs to the lower class, as on the map. */
export function classOf(
  classes: GuidelineClass[] | null,
  value: number,
): GuidelineClass | undefined {
  return classes?.find((c) => value <= c.upTo)
}

/** Room for the guideline level and the class above it, so the first bands are always visible. */
export function guidelineAxisMax(classes: GuidelineClass[], dataMax: number): number {
  return Math.max(dataMax, (classes[0]?.upTo ?? 0) * 2)
}

const NO_FILL = 'rgba(0, 0, 0, 0)'

function guidelineFill(property: string, unit: string) {
  const classes = guidelineClasses(property, unit)
  if (classes === null) return null
  const last = classes[classes.length - 1]
  // `case` with `<=` keeps a value exactly on a boundary in the lower class; `step` would not.
  const branches = classes.slice(0, -1).flatMap((c) => [['<=', ['get', 'value'], c.upTo], c.colour])
  return ['case', ...branches, last?.colour ?? NO_FILL]
}

export function stationCirclePaint(
  range: ValueRange | null,
  property: string | null = null,
): CircleLayerSpecification['paint'] {
  const [low, mid, high] = COLOUR_STOPS
  // Interpolation stops must strictly ascend. A range one float step wide would make the middle
  // stop equal to an end and invalidate the whole layer, so it counts as a single value.
  const middle = range === null ? 0 : (range.min + range.max) / 2
  const hasSpread = range !== null && range.min < middle && middle < range.max
  const classed = range === null || property === null ? null : guidelineFill(property, range.unit)
  const fill =
    classed ??
    (hasSpread
      ? ['interpolate', ['linear'], ['get', 'value'], range.min, low, middle, mid, range.max, high]
      : mid)
  return {
    'circle-radius': 9,
    // No value for this property: an empty ring, so the station is still visible.
    'circle-color': ['case', ['get', 'hasValue'], fill, NO_FILL],
    // A stale reading is faded, not hidden.
    'circle-opacity': ['case', ['get', 'stale'], 0.45, 1],
    'circle-stroke-width': 2,
    'circle-stroke-color': ['case', ['get', 'hasValue'], '#12201f', '#4d6360'],
    'circle-stroke-opacity': ['case', ['get', 'stale'], 0.45, 1],
  } as CircleLayerSpecification['paint']
}

/**
 * The number beside each marker. It sits to the right instead of inside, because a circle small
 * enough to be a marker cannot hold a value like 316. Where labels collide the highest value
 * is kept, and the marker itself is never hidden.
 */
export const STATION_LABEL_LAYOUT = {
  'text-field': ['get', 'label'],
  'text-font': ['Noto Sans Bold'],
  'text-size': 12,
  'text-anchor': 'left',
  'text-offset': [1.7, 0],
  // Highest value first; a station without one goes last, so a dash never pushes out a number.
  'symbol-sort-key': ['case', ['get', 'hasValue'], ['*', -1, ['get', 'value']], 1e9],
} as SymbolLayerSpecification['layout']

export const STATION_LABEL_PAINT = {
  'text-color': '#12201f',
  'text-halo-color': '#ffffff',
  'text-halo-width': 2,
  'text-opacity': ['case', ['get', 'stale'], 0.45, 1],
} as SymbolLayerSpecification['paint']
