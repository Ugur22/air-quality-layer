import { formatValue } from '@/lib/format'
import { formatAge, isStale } from '@/lib/freshness'
import { readingOf } from './stationReadings'
import type { StationFeature } from './types'

const OFFSET = 14

/**
 * A small label that follows the pointer over a station: its name and the value the map is
 * coloured by, so the number can be read without clicking. Clicking opens the full details.
 */
export function StationTooltip({
  station,
  property,
  unit,
  now,
  x,
  y,
  flipX = false,
  flipY = false,
}: {
  station: StationFeature
  property: string | null
  /** The unit the map scale uses; a reading in another unit is not on that scale. */
  unit?: string
  now: Date
  /** Pointer position inside the map, in pixels. */
  x: number
  y: number
  /** Put the tooltip left of / above the pointer, so it stays inside the map. */
  flipX?: boolean
  flipY?: boolean
}) {
  const reading = property === null ? undefined : readingOf(station, property)
  const otherUnit = reading !== undefined && unit !== undefined && reading.unit !== unit
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-20 max-w-60 rounded-lg bg-ink px-3 py-2 text-xs text-paper shadow-lg"
      style={{
        left: flipX ? x - OFFSET : x + OFFSET,
        top: flipY ? y - OFFSET : y + OFFSET,
        transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`,
      }}
    >
      <p className="font-display text-sm font-bold leading-snug">{station.properties.name}</p>
      <p className="font-mono">
        {property ?? 'No pollutant'}{' '}
        {reading ? `${formatValue(reading.value)} ${reading.unit}` : 'not reported'}
        {otherUnit ? ' (another unit than the map scale)' : ''}
      </p>
      <p className="opacity-70">
        {reading
          ? `${formatAge(reading.observed_at, now)}${isStale(reading.observed_at, now) ? ', stale' : ''} · `
          : ''}
        Click for details
      </p>
    </div>
  )
}
