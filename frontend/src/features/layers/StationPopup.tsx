import { formatAge, isStale } from '@/lib/freshness'
import { formatValue } from '@/lib/format'
import type { StationFeature } from './types'

export function StationPopup({
  station,
  now,
  property = null,
}: {
  station: StationFeature
  now: Date
  /** The reading the map is coloured by; its row is marked. */
  property?: string | null
}) {
  const readings = Object.entries(station.properties.readings).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return (
    <div className="min-w-56 max-w-72 text-ink">
      <p className="mb-2 font-display text-base font-bold">{station.properties.name}</p>
      {readings.length === 0 ? (
        <p className="text-sm text-muted">No readings reported by this station.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left font-mono text-xs uppercase tracking-wide text-muted">
              <th className="pb-1 pr-3 font-medium">Parameter</th>
              <th className="pb-1 pr-3 font-medium">Value</th>
              <th className="pb-1 font-medium">Observed</th>
            </tr>
          </thead>
          <tbody>
            {readings.map(([name, reading]) => (
              <tr
                key={name}
                aria-current={name === property ? 'true' : undefined}
                className="border-t border-line align-baseline aria-[current=true]:bg-accent-soft aria-[current=true]:font-semibold"
              >
                <td className="py-1 pl-1.5 pr-3 font-mono text-xs aria-[current=true]:shadow-none">
                  {name}
                </td>
                <td className="py-1 pr-3 tabular-nums">
                  {formatValue(reading.value)} {reading.unit}
                </td>
                <td className="py-1 text-xs text-muted">
                  {formatAge(reading.observed_at, now)}
                  {isStale(reading.observed_at, now) ? (
                    <span className="ml-1.5 rounded-full border border-warn/50 px-1.5 font-mono text-warn">
                      stale
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
