import { Command } from 'cmdk'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { formatAge } from '@/lib/freshness'
import { cn } from '@/lib/utils'
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
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  // The chosen code is always an option, so the box never looks empty or shows another country
  // while the list is loading, empty, or does not contain it.
  const listed = countries ?? []
  const options = listed.some((country) => country.code === code)
    ? listed
    : [{ code, name: code }, ...listed]
  const chosen = options.find((country) => country.code === code)?.name ?? code
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden className="text-sm font-medium leading-none text-ink">
        Country
      </span>
      <Command
        label="Country"
        className="relative"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        onBlur={(event) => {
          // Clicking an option moves focus inside the box; only leaving it closes the list.
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }}
      >
        <Command.Input
          // Closed, the box names the country shown; open, it is the search text.
          value={open ? search : chosen}
          placeholder={open ? chosen : undefined}
          onValueChange={(value) => {
            setSearch(value)
            setOpen(true)
          }}
          onFocus={() => {
            setSearch('')
            setOpen(true)
          }}
          onClick={() => {
            setOpen(true)
          }}
          className="flex h-10 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
        {open ? (
          <Command.List className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-line bg-surface p-1 shadow-md">
            <Command.Empty className="px-3 py-2 text-sm text-muted">
              No country found.
            </Command.Empty>
            {options.map((country) => (
              <Command.Item
                key={country.code}
                value={country.name}
                keywords={[country.code]}
                onSelect={() => {
                  onChange(country.code)
                  setOpen(false)
                }}
                className="flex cursor-pointer items-baseline justify-between gap-3 rounded px-3 py-2 text-sm aria-selected:bg-accent-soft"
              >
                <span className={cn(country.code === code && 'font-semibold')}>{country.name}</span>
                <span className="font-mono text-xs text-muted">{country.code}</span>
              </Command.Item>
            ))}
          </Command.List>
        ) : null}
      </Command>
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
