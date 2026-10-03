import type { CircleLayerSpecification } from 'maplibre-gl'
import { isStale } from '@/lib/freshness'
import type { StationFeature } from './types'

export interface MapStationProperties {
  id: string
  name: string
  hasValue: boolean
  value: number | null
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

const NO_FILL = 'rgba(0, 0, 0, 0)'

export function stationCirclePaint(range: ValueRange | null): CircleLayerSpecification['paint'] {
  const [low, mid, high] = COLOUR_STOPS
  // Interpolation stops must strictly ascend. A range one float step wide would make the middle
  // stop equal to an end and invalidate the whole layer, so it counts as a single value.
  const middle = range === null ? 0 : (range.min + range.max) / 2
  const hasSpread = range !== null && range.min < middle && middle < range.max
  const fill = hasSpread
    ? ['interpolate', ['linear'], ['get', 'value'], range.min, low, middle, mid, range.max, high]
    : mid
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
