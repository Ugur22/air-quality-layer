import { formatValue } from '@/lib/format'
import { formatAge, isStale } from '@/lib/freshness'
import type { StationFeature } from './types'

const OFFSET = 14

/**
 * A small label that follows the pointer over a station: its name and the value the map is
 * coloured by, so the number can be read without clicking. Clicking opens the full details.
 */
export function StationTooltip({
  station,
  property,
  now,
  x,
  y,
}: {
  station: StationFeature
  property: string | null
  now: Date
  /** Pointer position inside the map, in pixels. */
  x: number
  y: number
}) {
  const reading = property === null ? undefined : station.properties.readings[property]
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-20 max-w-60 rounded-lg bg-ink px-3 py-2 text-xs text-paper shadow-lg"
      style={{ left: x + OFFSET, top: y + OFFSET }}
    >
      <p className="font-display text-sm font-bold leading-snug">{station.properties.name}</p>
      <p className="font-mono">
        {property ?? 'No pollutant'}{' '}
        {reading ? `${formatValue(reading.value)} ${reading.unit}` : 'not reported'}
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
