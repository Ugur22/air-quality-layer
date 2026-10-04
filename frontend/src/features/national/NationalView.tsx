import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { formatAge } from '@/lib/freshness'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import type { MapLayerResponse } from '@/features/layers/types'
import type { Country } from './types'

const OPTIONS = [
  { national: false, label: 'Region' },
  { national: true, label: 'Country' },
] as const

/** Switches between the region being worked on and a whole country. */
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

/** Chooses which country the map shows. The server's list is the only source of countries. */
export function CountryPicker({
  countries,
  code,
  onChange,
}: {
  countries: Country[] | undefined
  code: string
  onChange: (code: string) => void
}) {
  // The chosen code is always an option, so the select never looks empty or shows another country
  // while the list is loading, empty, or does not contain it.
  const listed = countries ?? []
  const options = listed.some((country) => country.code === code)
    ? listed
    : [{ code, name: code }, ...listed]
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="country">Country</Label>
      <select
        id="country"
        value={code}
        onChange={(e) => {
          onChange(e.target.value)
        }}
        className="h-10 rounded-md border border-line bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {options.map((country) => (
          <option key={country.code} value={country.code}>
            {country.name}
          </option>
        ))}
      </select>
    </div>
  )
}

/** What the rail says in the country view: how fresh the layer is, and why it cannot be shown. */
export function NationalNotes({
  country,
  layer,
  loading,
  notBuiltYet,
  now,
}: {
  country: { code: string; name: string }
  layer: MapLayerResponse | null
  loading: boolean
  /** The server has no layer yet: the first hourly refresh has not succeeded. */
  notBuiltYet: boolean
  now: Date
}) {
  const refreshedAt = layer?.map_layer.refreshed_at
  return (
    <section aria-label={country.name} className="flex flex-col gap-3">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {country.name}
      </p>
      <h2 className="font-display text-lg font-bold leading-tight">All stations at once</h2>
      <p className="text-sm text-muted">
        {country.code === 'NL' ? 'OpenAQ and Luchtmeetnet stations' : 'OpenAQ stations'} across the
        country, refreshed by the server every hour. Nothing is fetched when you open this view.
      </p>
      {refreshedAt !== undefined ? (
        <p role="status" className="text-sm">
          Updated {formatAge(refreshedAt, now)}.
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted">
          Loading the stations…
        </p>
      ) : null}
      {notBuiltYet ? (
        <Alert>
          <AlertDescription>
            The layer for this country has not been built yet. The server builds it every hour, so
            try again shortly.
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}
