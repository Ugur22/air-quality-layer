import type { Reading, StationFeature } from './types'

export function newestObservation(station: StationFeature): string | null {
  const times = Object.values(station.properties.readings).map((r) => r.observed_at)
  if (times.length === 0) return null
  // Compared as instants: timestamp text with different offsets or fractions does not sort by time.
  return times.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b))
}

/** A station's reading of one pollutant, or undefined: a station need not report every one. */
export function readingOf(station: StationFeature, property: string): Reading | undefined {
  return station.properties.readings[property]
}
