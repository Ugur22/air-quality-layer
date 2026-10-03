import { useCallback, useMemo } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import type { Bbox } from '@/features/regions/types'
import { boxProblem, draftBbox } from '@/features/regions/validation'
import { describeError } from '@/features/syncs/messages'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { useSession } from '@/stores/session'
import { useFilteredMapLayer } from './api'
import { parseFilterValue, type LayerFilter } from './filter'
import { FILTER_DEBOUNCE_MS } from './filterTiming'
import { LayerFilterControls } from './LayerFilterControls'
import { pickColourProperty } from './mapData'
import { StationList } from './StationList'
import { StationMap } from './StationMap'
import type { MapLayerResponse } from './types'

export function ResultPanel({
  layer,
  now,
  idle,
}: {
  layer: MapLayerResponse | null
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
    },
    [setDraftField],
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
  const filtered = useFilteredMapLayer(layer?.map_layer.id ?? null, filter)

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

  return (
    <div className="flex flex-col gap-4">
      {layer && property !== null ? (
        <div className="flex flex-col gap-4">
          <div className="flex max-w-xs flex-col gap-1.5">
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
                  {key}
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
        </div>
      ) : null}
      <section aria-label="Map" aria-describedby="map-hint" className="flex flex-col gap-3">
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
        />
        <p id="map-hint" className="text-sm text-muted">
          {box === null
            ? `This box cannot be used${problem ? `: ${problem}` : '.'} Draw a new one or fix the numbers.`
            : layer === null && idle
              ? 'The dashed box is the region you are about to sync. Press “Create region and sync” to load the stations OpenAQ has inside it.'
              : null}
        </p>
      </section>
      {layer ? (
        <StationList
          stations={stations}
          selectedId={selectedId}
          onSelect={selectStation}
          now={now}
          emptyMessage={visibleIds ? 'No stations match this filter.' : undefined}
        />
      ) : null}
    </div>
  )
}
