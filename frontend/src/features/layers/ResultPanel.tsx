import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { DEFAULT_COUNTRY } from '@/features/national/types'
import type { Bbox } from '@/features/regions/types'
import { boxProblem, draftBbox, DRAWN_AREA_NAME, isBoxEmpty } from '@/features/regions/validation'
import { describeError } from '@/features/syncs/messages'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { useSession } from '@/stores/session'
import { useFilteredMapLayer } from './api'
import { parseFilterValue, type LayerFilter } from './filter'
import { FILTER_DEBOUNCE_MS } from './filterTiming'
import { pollutantLabel } from './pollutants'
import { LayerFilterControls } from './LayerFilterControls'
import { pickColourProperty, valueRange } from './mapData'
import { StationDialog } from './StationDialog'
import { StationList } from './StationList'
import { StationMap } from './StationMap'
import type { MapLayerResponse } from './types'

export function ResultPanel({
  layer,
  now,
  idle,
  rail = null,
  title = 'Stations',
  loading = false,
  error = null,
  countryView = null,
}: {
  /** Shown at the top of the left rail, above the filter. */
  rail?: ReactNode
  /** Heading of the station list, normally the region's name. */
  title?: string
  loading?: boolean
  /** Why the layer could not be loaded, already worded for the user. */
  error?: string | null
  layer: MapLayerResponse | null
  /** The country being looked at in the country view, for framing it before its layer arrives. */
  countryView?: { code: string; bbox: Bbox } | null
  /** When the layer was fetched: one clock for the map, the popup and the list. */
  now: Date
  /** Nothing is running or loading, so telling the user what to do next makes sense. */
  idle: boolean
}) {
  const draft = useSession((s) => s.draft)
  const colourProperty = useSession((s) => s.colourProperty)
  const setColourProperty = useSession((s) => s.setColourProperty)
  const selectedStationId = useSession((s) => s.selectedStationId)
  const selectStation = useSession((s) => s.selectStation)
  const setDraftField = useSession((s) => s.setDraftField)
  const setCustomAreaOpen = useSession((s) => s.setCustomAreaOpen)
  const setAreaName = useSession((s) => s.setAreaName)
  const viewRequest = useSession((s) => s.viewRequest)
  const comparator = useSession((s) => s.filterComparator)
  const filterValue = useSession((s) => s.filterValue)

  const box = useMemo(() => draftBbox(draft), [draft])
  const problem = useMemo(() => boxProblem(draft), [draft])
  // A drawn rectangle goes into the form's values like typed ones, so the form stays the one
  // place the region is defined and validated.
  const writeBox = useCallback(
    ([minLon, minLat, maxLon, maxLat]: Bbox) => {
      setDraftField('minLon', String(minLon))
      setDraftField('minLat', String(minLat))
      setDraftField('maxLon', String(maxLon))
      setDraftField('maxLat', String(maxLat))
      // The area is no longer the place the name came from, and the region needs a name; one the
      // user typed is kept. The numbers are shown so they can be adjusted.
      const { draft, autoName } = useSession.getState()
      if (draft.name.trim() === '' || draft.name === autoName) setAreaName(DRAWN_AREA_NAME)
      setCustomAreaOpen(true)
    },
    [setDraftField, setAreaName, setCustomAreaOpen],
  )
  const keys = layer?.map_layer.property_keys ?? []
  // A remembered choice only counts while this layer still has that property.
  const property =
    colourProperty !== null && keys.includes(colourProperty)
      ? colourProperty
      : pickColourProperty(keys)

  // The pollutant chosen for colouring is also the one the filter applies to. Only the typed number
  // waits for typing to pause; choosing a pollutant or comparator applies at once, and clearing
  // the box removes the filter at once.
  const parsed = useMemo(() => parseFilterValue(filterValue), [filterValue])
  const settledText = useDebouncedValue(filterValue, FILTER_DEBOUNCE_MS)
  const settled = useMemo(
    () => parseFilterValue(filterValue.trim() === '' ? '' : settledText),
    [filterValue, settledText],
  )
  const settledValue = settled.kind === 'ok' ? settled.value : null
  const hasLayer = layer !== null
  const filter = useMemo<LayerFilter | null>(
    () =>
      hasLayer && property !== null && settledValue !== null
        ? { property, comparator, value: settledValue }
        : null,
    [hasLayer, property, comparator, settledValue],
  )
  const queryClient = useQueryClient()
  const filtered = useFilteredMapLayer(
    layer?.map_layer.id ?? null,
    filter,
    layer?.map_layer.region_id === null ? (layer.map_layer.country ?? DEFAULT_COUNTRY) : null,
  )

  // The server rebuilds the national layer under a new id and always answers with the newest one,
  // so a filtered answer for another id means the layer on screen is out of date: reload it.
  const answeredFor = filter ? filtered.data?.map_layer.id : undefined
  const shownId = layer?.map_layer.id
  const isNational = layer?.map_layer.region_id === null
  useEffect(() => {
    if (isNational && answeredFor !== undefined && answeredFor !== shownId) {
      void queryClient.invalidateQueries({ queryKey: ['national-layer'] })
    }
  }, [isNational, answeredFor, shownId, queryClient])

  // Only an answer for this very layer may decide what is shown (the previous answer is kept on
  // screen while a new one loads, and after a new sync it could belong to the old layer).
  const answer =
    filter && filtered.data?.map_layer.id === layer?.map_layer.id ? filtered.data : undefined
  // What is typed or chosen is ahead of what is shown, or the shown answer is a kept-over one.
  const updating =
    (parsed.kind === 'ok' && parsed.value !== settledValue) ||
    (filter !== null && (filtered.isPlaceholderData || (filtered.isFetching && !answer)))

  const allStations = useMemo(() => layer?.stations.features ?? [], [layer])
  const visibleIds = useMemo(
    () => (answer ? new Set(answer.stations.features.map((f) => f.id)) : null),
    [answer],
  )
  const stations = useMemo(
    () => (visibleIds ? allStations.filter((s) => visibleIds.has(s.id)) : allStations),
    [allStations, visibleIds],
  )
  const selectedId = stations.some((s) => s.id === selectedStationId) ? selectedStationId : null
  const selectedStation = stations.find((s) => s.id === selectedId)

  return (
    <div className="grid h-full lg:grid-cols-[22.5rem_minmax(0,1fr)]">
      <div className="flex min-h-0 min-w-0 flex-col">
        <section
          aria-label="Map"
          aria-describedby="map-hint"
          className="relative h-[26rem] lg:h-auto lg:min-h-64 lg:flex-1"
        >
          <StationMap
            layer={layer}
            visibleIds={visibleIds}
            draftBbox={box}
            property={property}
            selectedId={selectedId}
            onSelect={selectStation}
            now={now}
            onBoxDrawn={writeBox}
            viewRequest={viewRequest}
            countryView={countryView}
          />
        </section>
        <p
          id="map-hint"
          className="border-t border-line bg-surface px-4 py-2 text-sm text-muted empty:hidden"
        >
          {isBoxEmpty(draft)
            ? layer === null && idle
              ? 'Search for a place, or choose “Draw region” and drag on the map, to pick the area to load.'
              : null
            : box === null
              ? `This box cannot be used${problem ? `: ${problem}` : '.'} Draw a new one or fix the numbers.`
              : layer === null && idle
                ? 'The dashed box is the region you are about to sync. Press “Create region and sync” to load the stations OpenAQ has inside it.'
                : null}
        </p>
        {loading ? (
          <p role="status" className="border-t border-line bg-surface px-4 py-2 text-sm text-muted">
            Loading stations…
          </p>
        ) : null}
        {error !== null ? (
          <div className="border-t border-line bg-surface px-4 py-2">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {layer ? (
          <section
            aria-label="Station list"
            className="flex max-h-60 min-h-0 flex-col border-t border-line bg-surface"
          >
            <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
              <h2 className="font-display text-[15px] font-bold">{title}</h2>
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                {stations.length === 1 ? '1 station' : `${String(stations.length)} stations`}
              </span>
            </div>
            <div className="min-h-0 overflow-y-auto">
              <StationList
                stations={stations}
                selectedId={selectedId}
                onSelect={selectStation}
                now={now}
                property={property}
                unit={valueRange(allStations, property)?.unit}
                emptyMessage={visibleIds ? 'No stations match this filter.' : undefined}
              />
            </div>
          </section>
        ) : null}
      </div>
      <section
        aria-label="Region and filter"
        className="flex flex-col gap-5 border-t border-line bg-surface p-4 lg:order-first lg:overflow-y-auto lg:border-r lg:border-t-0"
      >
        {rail}
        {layer && property !== null ? (
          <section aria-label="Filter" className="flex flex-col gap-3 border-t border-line pt-5">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              Filter
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="colour-property">Pollutant</Label>
              <select
                id="colour-property"
                value={property}
                onChange={(e) => {
                  setColourProperty(e.target.value)
                }}
                className="h-10 rounded-md border border-line bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                {keys.map((key) => (
                  <option key={key} value={key}>
                    {pollutantLabel(key)}
                  </option>
                ))}
              </select>
            </div>
            <LayerFilterControls property={property} parsed={settled} />
            {/* One status element stays mounted so screen readers announce its changes. */}
            <p role="status" className="text-sm">
              {filtered.isError
                ? null
                : updating
                  ? 'Updating…'
                  : filter && visibleIds
                    ? stations.length === 0
                      ? 'No stations match this filter.'
                      : `Showing ${String(stations.length)} of ${String(allStations.length)} stations.`
                    : null}
            </p>
            {filtered.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{describeError(filtered.error)}</AlertDescription>
              </Alert>
            ) : null}
          </section>
        ) : null}
      </section>
      {selectedStation && layer ? (
        <StationDialog
          key={selectedStation.id}
          station={selectedStation}
          stations={allStations}
          layerId={layer.map_layer.id}
          property={property}
          now={now}
          onClose={() => {
            selectStation(null)
          }}
        />
      ) : null}
    </div>
  )
}
