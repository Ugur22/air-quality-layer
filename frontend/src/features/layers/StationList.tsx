import { formatAge, isStale } from '@/lib/freshness'
import { formatValue } from '@/lib/format'
import type { StationFeature } from './types'

function newestObservation(station: StationFeature): string | null {
  const times = Object.values(station.properties.readings).map((r) => r.observed_at)
  if (times.length === 0) return null
  // Compared as instants: timestamp text with different offsets or fractions does not sort by time.
  return times.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b))
}

export function StationList({
  stations,
  selectedId,
  onSelect,
  now,
  property = null,
  emptyMessage = 'No stations to show.',
}: {
  stations: StationFeature[]
  selectedId: string | null
  onSelect: (id: string) => void
  now: Date
  /** The reading shown at the right of each row: the one the map is coloured by. */
  property?: string | null
  emptyMessage?: string
}) {
  if (stations.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted">{emptyMessage}</p>
  }
  // Highest first, so the stations worth a look are on top; those without the reading go last.
  const valueOf = (station: StationFeature) =>
    property === null ? undefined : station.properties.readings[property]?.value
  const ordered =
    property === null
      ? stations
      : [...stations].sort((a, b) => (valueOf(b) ?? -Infinity) - (valueOf(a) ?? -Infinity))
  return (
    <ul className="divide-y divide-line">
      {ordered.map((station) => {
        const newest = newestObservation(station)
        const stale = newest !== null && isStale(newest, now)
        const reading = property === null ? undefined : station.properties.readings[property]
        const readingCount = Object.keys(station.properties.readings).length
        return (
          <li key={station.id}>
            <button
              type="button"
              aria-pressed={station.id === selectedId}
              onClick={() => {
                onSelect(station.id)
              }}
              className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-accent-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-pressed:bg-accent-soft"
            >
              <span>
                <span className="block font-medium">{station.properties.name}</span>
                <span className="block text-xs text-muted">
                  {readingCount === 1 ? '1 reading' : `${String(readingCount)} readings`}
                  {newest ? `, latest ${formatAge(newest, now)}` : ''}
                </span>
              </span>
              <span className="flex items-center gap-3">
                {stale ? (
                  <span className="rounded-full border border-warn/50 px-2 py-0.5 font-mono text-xs text-warn">
                    stale
                  </span>
                ) : null}
                {reading ? (
                  <span className="font-mono text-base font-semibold tabular-nums">
                    <span className="sr-only">{property}: </span>
                    {formatValue(reading.value)}{' '}
                    <span className="text-xs font-normal text-muted">{reading.unit}</span>
                  </span>
                ) : property !== null ? (
                  <span className="text-xs italic text-muted">no {property}</span>
                ) : null}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
