import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { formatAge } from '@/lib/freshness'
import { cn } from '@/lib/utils'
import type { MapLayerResponse } from '@/features/layers/types'

const OPTIONS = [
  { national: false, label: 'Region' },
  { national: true, label: 'Netherlands' },
] as const

/** Switches between the region being worked on and the whole country. */
export function ViewSwitch({
  national,
  onChange,
}: {
  national: boolean
  onChange: (national: boolean) => void
}) {
  return (
    <div role="group" aria-label="Area to show" className="flex gap-1 rounded-md bg-paper p-1">
      {OPTIONS.map((option) => (
        <Button
          key={option.label}
          type="button"
          size="sm"
          variant={option.national === national ? 'default' : 'ghost'}
          aria-pressed={option.national === national}
          onClick={() => {
            onChange(option.national)
          }}
          className={cn('flex-1', option.national !== national && 'text-muted')}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

/** What the rail says in the country view: how fresh the layer is, and why it cannot be shown. */
export function NationalNotes({
  layer,
  loading,
  notBuiltYet,
  now,
}: {
  layer: MapLayerResponse | null
  loading: boolean
  /** The server has no layer yet: the first hourly refresh has not succeeded. */
  notBuiltYet: boolean
  now: Date
}) {
  const refreshedAt = layer?.map_layer.refreshed_at
  return (
    <section aria-label="Netherlands" className="flex flex-col gap-3">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        Netherlands
      </p>
      <h2 className="font-display text-lg font-bold leading-tight">All stations at once</h2>
      <p className="text-sm text-muted">
        OpenAQ and Luchtmeetnet stations across the country, refreshed by the server every hour.
        Nothing is fetched when you open this view.
      </p>
      {refreshedAt !== undefined ? (
        <p role="status" className="text-sm">
          Updated {formatAge(refreshedAt, now)}.
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted">
          Loading the national layer…
        </p>
      ) : null}
      {notBuiltYet ? (
        <Alert>
          <AlertDescription>
            The national layer has not been built yet. The server builds it every hour, so try again
            shortly.
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}
