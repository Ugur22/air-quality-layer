import { Command } from 'cmdk'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { formatAge } from '@/lib/freshness'
import { cn } from '@/lib/utils'
import type { MapLayerResponse } from '@/features/layers/types'
import { COUNTRY_COLOURS, MAX_COUNTRIES } from './compare'
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

/**
 * Chooses which countries the map shows: one, or two to compare. The server's list is the only
 * source of countries.
 */
export function CountryPicker({
  countries,
  codes,
  onToggle,
}: {
  countries: Country[] | undefined
  codes: string[]
  onToggle: (code: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  // A chosen code is always an option, so a chip never shows blank while the list is loading,
  // empty, or does not contain it.
  const listed = countries ?? []
  const options = [
    ...codes
      .filter((code) => !listed.some((c) => c.code === code))
      .map((code) => ({ code, name: code })),
    ...listed,
  ]
  const nameOf = (code: string) => options.find((c) => c.code === code)?.name ?? code
  const full = codes.length >= MAX_COUNTRIES
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden className="text-sm font-medium leading-none text-ink">
        Countries
      </span>
      <div role="group" aria-label="Chosen countries" className="flex flex-wrap gap-1.5">
        {codes.map((code, i) => (
          <span
            key={code}
            className="flex items-center gap-1.5 rounded-full border border-line bg-paper py-1 pl-2.5 pr-1 text-sm"
          >
            <span
              aria-hidden
              className="size-2.5 rounded-full"
              style={{ backgroundColor: COUNTRY_COLOURS[i] }}
            />
            {nameOf(code)}
            <button
              type="button"
              disabled={codes.length === 1}
              aria-label={`Remove ${nameOf(code)}`}
              onClick={() => {
                onToggle(code)
              }}
              className="grid size-5 place-items-center rounded-full text-muted hover:bg-accent-soft disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-accent"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <Command
        label="Countries"
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
          value={search}
          placeholder={full ? 'Two countries chosen' : 'Add a country to compare'}
          onValueChange={(value) => {
            setSearch(value)
            setOpen(true)
          }}
          onFocus={() => {
            setOpen(true)
          }}
          onClick={() => {
            setOpen(true)
          }}
          className="flex h-10 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
        {open ? (
          <Command.List className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-line bg-surface p-1 shadow-md">
            <Command.Empty className="px-3 py-2 text-sm text-muted">
              No country found.
            </Command.Empty>
            {options.map((country) => {
              const chosen = codes.includes(country.code)
              // The last country cannot be removed here either, or the view would be empty.
              const blocked = chosen ? codes.length === 1 : full
              return (
                <Command.Item
                  key={country.code}
                  value={country.name}
                  keywords={[country.code]}
                  disabled={blocked}
                  onSelect={() => {
                    onToggle(country.code)
                    setSearch('')
                  }}
                  className="flex cursor-pointer items-baseline justify-between gap-3 rounded px-3 py-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-selected:bg-accent-soft"
                >
                  <span className={cn(chosen && 'font-semibold')}>
                    {chosen ? '✓ ' : null}
                    {country.name}
                  </span>
                  <span className="font-mono text-xs text-muted">{country.code}</span>
                </Command.Item>
              )
            })}
          </Command.List>
        ) : null}
      </Command>
      {full ? (
        <p className="text-xs text-muted">Remove one to compare a different country.</p>
      ) : null}
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
