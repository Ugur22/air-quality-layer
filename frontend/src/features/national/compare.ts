import { isStale } from '@/lib/freshness'
import { readingOf } from '@/features/layers/stationReadings'
import type { Bbox } from '@/features/regions/types'
import type { MapLayerResponse, StationFeature } from '@/features/layers/types'

/** The most countries that can be shown (and compared) at once. */
export const MAX_COUNTRIES = 2

/** Border colour per slot, so a station's country is readable from the line around it. */
export const COUNTRY_COLOURS = ['#0a7570', '#b45309'] as const

export function unionBbox(boxes: Bbox[]): Bbox | null {
  const [first, ...rest] = boxes
  if (!first) return null
  return rest.reduce<Bbox>(
    (a, b) => [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3]),
    ],
    first,
  )
}

/**
 * National layers of several countries as one layer for the map. Station ids are only used as
 * keys within a layer, so each station is tagged with its country to find its own layer again.
 */
export function mergeLayers(layers: MapLayerResponse[]): MapLayerResponse | null {
  const [only, ...others] = layers
  if (!only) return null
  const parts = layers.map((l) => ({ country: l.map_layer.country ?? '', id: l.map_layer.id }))
  if (others.length === 0) return { ...only, map_layer: { ...only.map_layer, parts } }
  const keys = [...new Set(layers.flatMap((l) => l.map_layer.property_keys))]
  const refreshed = layers
    .map((l) => l.map_layer.refreshed_at)
    .filter((t): t is string => t !== undefined)
    .sort()
  return {
    map_layer: {
      id: parts.map((p) => p.id).join('+'),
      region_id: null,
      station_count: layers.reduce((sum, l) => sum + l.map_layer.station_count, 0),
      bbox: unionBbox(layers.map((l) => l.map_layer.bbox)) ?? only.map_layer.bbox,
      property_keys: keys,
      // The oldest refresh: the merged layer is only as fresh as its stalest part.
      ...(refreshed[0] === undefined ? {} : { refreshed_at: refreshed[0] }),
      parts,
    },
    stations: {
      type: 'FeatureCollection',
      features: layers.flatMap((l) =>
        l.stations.features.map((f) => ({
          ...f,
          properties: { ...f.properties, country: l.map_layer.country ?? '' },
        })),
      ),
    },
  }
}

export interface PollutantSummary {
  /** Stations in view for this country. */
  stations: number
  /** Stations with a fresh reading of the pollutant; the figures below are over these. */
  reporting: number
  mean: number | null
  median: number | null
  min: number | null
  max: number | null
  unit: string | null
}

/**
 * Figures for one pollutant over some stations. A stale reading is left out: an old value would
 * pull the figures toward a day that is not today.
 */
export function summarise(
  stations: StationFeature[],
  property: string,
  now: Date,
): PollutantSummary {
  const values: number[] = []
  let unit: string | null = null
  for (const station of stations) {
    const reading = readingOf(station, property)
    if (reading === undefined || isStale(reading.observed_at, now)) continue
    values.push(reading.value)
    unit ??= reading.unit
  }
  values.sort((a, b) => a - b)
  const n = values.length
  const lower = values[Math.floor((n - 1) / 2)]
  const upper = values[Math.floor(n / 2)]
  const median = lower === undefined || upper === undefined ? null : (lower + upper) / 2
  return {
    stations: stations.length,
    reporting: n,
    mean: n === 0 ? null : values.reduce((a, b) => a + b, 0) / n,
    median,
    min: values[0] ?? null,
    max: values.at(-1) ?? null,
    unit,
  }
}
