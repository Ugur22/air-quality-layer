import { Command } from 'cmdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { describeError } from '@/features/syncs/messages'
import { ApiError } from '@/lib/api'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { useSession } from '@/stores/session'
import { MIN_QUERY_LENGTH, usePlaceSearch } from './api'
import { PLACE_SEARCH_DEBOUNCE_MS } from './searchTiming'
import type { Place } from './types'

/** The server's words for a refused or failed search are already written for the user. */
function describeSearchError(error: unknown): string {
  if (error instanceof ApiError && error.code !== 'network_error' && error.message !== '') {
    return error.message
  }
  return describeError(error)
}

/** Says what else can be done, unless the message already does (the server's 503 text does). */
function withFallbackAdvice(message: string): string {
  return /coordinates|draw/i.test(message)
    ? message
    : `${message} You can type coordinates or draw an area instead.`
}

const MAX_QUERY_LENGTH = 100
const STATUS_ID = 'place-search-status'

/**
 * Find a place by name and use its box as the region (ADR 0013). Choosing a result writes the
 * box into the region form's values, the same place typing and drawing write to, so the form
 * stays the one place a region is defined and checked. A name the user typed is kept.
 */
export function PlaceSearchBox() {
  const setDraft = useSession((s) => s.setDraft)
  const setAreaName = useSession((s) => s.setAreaName)
  const focusBox = useSession((s) => s.focusBox)
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  // The place last chosen and the four box values it wrote, to notice when the area has moved on.
  const [chosen, setChosen] = useState<{ name: string; box: string[] } | null>(null)
  const draft = useSession((s) => s.draft)
  const inputRef = useRef<HTMLInputElement>(null)

  // Once the area is drawn or typed elsewhere, the chosen place no longer describes it: its name
  // and the "Region set to" message would be wrong, so the box shows nothing until searched again.
  const stale =
    chosen !== null &&
    [draft.minLon, draft.minLat, draft.maxLon, draft.maxLat].some((v, i) => v !== chosen.box[i])
  const shownText = stale && text === chosen.name ? '' : text

  const typed = useMemo(() => text.trim().replace(/\s+/g, ' '), [text])
  const settled = useDebouncedValue(typed, PLACE_SEARCH_DEBOUNCE_MS)
  // Searched only while the list is open: filling the box with a chosen name is not a new search.
  const search = usePlaceSearch(settled, open)
  const enough = typed.length >= MIN_QUERY_LENGTH
  const setCustomAreaOpen = useSession((s) => s.setCustomAreaOpen)
  // When search cannot help, the typed and drawn ways of defining an area must be in reach.
  useEffect(() => {
    if (open && enough && search.isError) setCustomAreaOpen(true)
  }, [open, enough, search.isError, setCustomAreaOpen])
  // Results belong to what is typed now. While typing goes on, or an answer is a kept-over one
  // for earlier text, nothing old is offered for choosing.
  const fresh = settled === typed && !search.isPlaceholderData
  const places = open && enough && fresh && !search.isError ? (search.data ?? []) : []

  const choose = (place: Place) => {
    if (!place.bbox) return
    const [minLon, minLat, maxLon, maxLat] = place.bbox
    const { draft, autoName } = useSession.getState()
    // A name the user typed themselves is theirs; one the app put there (a place, a drawn area)
    // is not.
    const replaceName = draft.name.trim() === '' || draft.name === autoName
    if (replaceName) setAreaName(place.name)
    setDraft({
      minLon: String(minLon),
      minLat: String(minLat),
      maxLon: String(maxLon),
      maxLat: String(maxLat),
    })
    focusBox(place.bbox)
    setChosen({ name: place.name, box: place.bbox.map(String) })
    setText(place.name)
    setOpen(false)
    setAnnouncement(
      replaceName
        ? `Region set to ${place.name}. Press Create region and sync to load its stations.`
        : `Box set to ${place.name}; your region name was kept. Press Create region and sync.`,
    )
    inputRef.current?.focus()
  }

  let status = ''
  if (open && enough) {
    if (search.isError) status = ''
    else if (!fresh || search.data === undefined) status = 'Searching…'
    else if (search.data.length === 0) status = 'No places found.'
    else
      status = `${String(search.data.length)} ${search.data.length === 1 ? 'place' : 'places'} found. Use the arrow keys to choose one.`
  } else if (shownText !== '' && !enough) {
    status = 'Type at least 3 characters.'
  } else if (!open) {
    status = stale ? '' : announcement
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* cmdk names the input from the Command label below; this text is the visible copy of it. */}
      <span aria-hidden className="text-sm font-medium leading-none text-ink">
        Search for a place
      </span>
      <Command
        shouldFilter={false}
        label="Search for a place"
        className="relative"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
          if (event.key === 'ArrowDown' && !open && enough) setOpen(true)
        }}
        onBlur={(event) => {
          // Clicking a result moves focus inside the box; only leaving it closes the list.
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }}
      >
        <Command.Input
          ref={inputRef}
          value={shownText}
          maxLength={MAX_QUERY_LENGTH}
          aria-describedby={STATUS_ID}
          onValueChange={(value) => {
            setText(value)
            setAnnouncement('')
            setOpen(true)
          }}
          onClick={() => {
            if (enough) setOpen(true)
          }}
          placeholder="e.g. Amsterdam or Vondelpark"
          className="flex h-10 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
        {places.length > 0 ? (
          <Command.List className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-line bg-surface p-1 shadow-md">
            {places.map((place) => (
              <Command.Item
                key={place.id}
                value={place.id}
                disabled={place.bbox === null}
                onSelect={() => {
                  choose(place)
                }}
                className="flex cursor-pointer flex-col gap-0.5 rounded px-3 py-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-selected:bg-accent-soft"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{place.name}</span>
                  <span className="font-mono text-xs text-muted">{place.kind}</span>
                </span>
                {place.detail !== '' ? (
                  <span className="text-xs text-muted">{place.detail}</span>
                ) : null}
                {place.bbox === null ? (
                  <span className="text-xs text-warn">
                    Too large for a region (over 2 degrees). Search for a smaller place.
                  </span>
                ) : null}
              </Command.Item>
            ))}
          </Command.List>
        ) : null}
      </Command>
      {/* Always mounted, so a screen reader announces each change of what the search is doing. */}
      <p id={STATUS_ID} role="status" className="min-h-4 text-xs text-muted">
        {status}
      </p>
      {open && enough && search.isError ? (
        <p role="alert" className="text-sm text-bad">
          {withFallbackAdvice(describeSearchError(search.error))}
        </p>
      ) : null}
      <p className="text-xs text-muted">
        Search by{' '}
        <a className="underline" href="https://photon.komoot.io" target="_blank" rel="noreferrer">
          Photon
        </a>{' '}
        · ©{' '}
        <a
          className="underline"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          OpenStreetMap
        </a>{' '}
        contributors
      </p>
    </div>
  )
}
