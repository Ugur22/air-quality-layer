import 'maplibre-gl/dist/maplibre-gl.css'
import { SquareDashedMousePointer } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Map, NavigationControl, Popup, Source, type MapRef } from 'react-map-gl/maplibre'
import type { Bbox } from '@/features/regions/types'
import { Button } from '@/components/ui/button'
import { BASEMAP_STYLE_URL } from '@/lib/config'
import { formatValue } from '@/lib/format'
import { buildMapData, COLOUR_STOPS, stationCirclePaint, valueRange } from './mapData'
import { startRectangleDrawing } from './regionDrawing'
import { StationPopup } from './StationPopup'
import type { MapLayerResponse } from './types'

const FIT_PADDING = 48
// Roughly the Netherlands, for when there is neither a layer nor a usable box to look at.
const DEFAULT_VIEW = { longitude: 5.3, latitude: 52.2, zoom: 6 }
const EMPTY = { type: 'FeatureCollection' as const, features: [] }

function sameBox(a: Bbox, b: Bbox | null): boolean {
  return b !== null && a.every((v, i) => v === b[i])
}

function outline([minLon, minLat, maxLon, maxLat]: Bbox) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
  }
}

function Legend({
  property,
  range,
  showSyncedBox,
}: {
  property: string | null
  range: ReturnType<typeof valueRange>
  showSyncedBox: boolean
}) {
  return (
    <div role="group" aria-label="Map legend" className="flex flex-col gap-1.5 text-xs text-muted">
      {property === null || range === null ? (
        <p>{property === null ? 'Nothing to colour by.' : `No station reports ${property}.`}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-ink">{property}</span>
          <span className="tabular-nums">{formatValue(range.min)}</span>
          <span
            aria-hidden
            className="h-2.5 w-32 rounded-full border border-line"
            style={{ background: `linear-gradient(to right, ${COLOUR_STOPS.join(', ')})` }}
          />
          <span className="tabular-nums">
            {formatValue(range.max)} {range.unit}
          </span>
          <span>(relative to this layer)</span>
        </div>
      )}
      {range !== null && range.otherUnitCount > 0 ? (
        <p>
          {range.otherUnitCount === 1
            ? `1 station reports ${String(property)} in another unit and is`
            : `${String(range.otherUnitCount)} stations report ${String(property)} in another unit and are`}{' '}
          left off this scale and drawn as a hollow ring; the popup shows the real value.
        </p>
      ) : null}
      <p>
        Faded dot: the reading is 24 hours old or older. Hollow ring: no usable value to colour.
      </p>
      {showSyncedBox ? (
        <p>Dashed box: the region in the form. Solid box: the region these stations come from.</p>
      ) : null}
    </div>
  )
}

/**
 * The map is always on screen: before the first sync it shows the box typed in the form, so the
 * user sees where they are about to look. `layer` adds the stations of a finished sync.
 */
export function StationMap({
  layer,
  visibleIds = null,
  draftBbox,
  property,
  selectedId,
  onSelect,
  now,
  onBoxDrawn,
  viewRequest = null,
}: {
  layer: MapLayerResponse | null
  /** When a filter is active, the ids of the stations that match it; null shows all. */
  visibleIds?: ReadonlySet<string> | null
  draftBbox: Bbox | null
  property: string | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  now: Date
  /** Receives a rectangle drawn on the map; without it no drawing button is offered. */
  onBoxDrawn?: (bbox: Bbox) => void
  /** Moves the camera to a box (a chosen place); a request with a new id moves it again. */
  viewRequest?: { bbox: Bbox; id: number } | null
}) {
  const mapRef = useRef<MapRef>(null)
  const [pointer, setPointer] = useState(false)
  const [drawing, setDrawing] = useState(false)
  // One live region, always mounted, so a screen reader announces each change.
  const [announcement, setAnnouncement] = useState('')
  const stations = useMemo(() => layer?.stations.features ?? [], [layer])
  const layerBbox = layer?.map_layer.bbox ?? null

  const visible = useMemo(
    () => (visibleIds ? stations.filter((s) => visibleIds.has(s.id)) : stations),
    [stations, visibleIds],
  )
  // The colour scale always comes from the whole layer, so colours keep their meaning while filtering.
  const data = useMemo(
    () => buildMapData(visible, property, now, stations),
    [visible, stations, property, now],
  )
  const range = useMemo(() => valueRange(stations, property), [stations, property])
  const paint = useMemo(() => stationCirclePaint(range), [range])
  const region = useMemo(() => (draftBbox ? outline(draftBbox) : EMPTY), [draftBbox])
  // After a sync the form can be edited away from the region the stations belong to; both are drawn.
  const showSyncedBox = layerBbox !== null && !sameBox(layerBbox, draftBbox)
  const syncedRegion = useMemo(
    () => (layerBbox && showSyncedBox ? outline(layerBbox) : EMPTY),
    [layerBbox, showSyncedBox],
  )
  const selected = visible.find((s) => s.id === selectedId)

  // initialViewState frames the first view. When a sync finishes (or another one replaces it) the
  // camera moves to that region; typing in the form never moves the camera.
  const fittedFor = useRef(layer?.map_layer.id ?? null)
  const layerId = layer?.map_layer.id ?? null
  useEffect(() => {
    const map = mapRef.current
    if (layerId === null || layerId === fittedFor.current || !map || !layerBbox) return
    map.fitBounds(layerBbox, { padding: FIT_PADDING, duration: 0 })
    fittedFor.current = layerId
  }, [layerId, layerBbox])

  // A chosen place moves the camera once; a request that was already there when the map appeared
  // (a remount) does not move it again.
  const lastViewId = useRef(viewRequest?.id ?? 0)
  useEffect(() => {
    const map = mapRef.current
    if (!viewRequest || viewRequest.id === lastViewId.current || !map) return
    map.fitBounds(viewRequest.bbox, { padding: FIT_PADDING, duration: 600 })
    lastViewId.current = viewRequest.id
  }, [viewRequest])

  // Drawing is on only while the button says so; finishing, pressing again, Escape or leaving the
  // page all stop it, and the drawn shape never outlives the gesture.
  useEffect(() => {
    if (!drawing || !onBoxDrawn) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const stop = startRectangleDrawing(map, (bbox) => {
      onBoxDrawn(bbox)
      setAnnouncement('Box drawn. The form now shows its coordinates.')
      setDrawing(false)
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAnnouncement('Drawing cancelled.')
      setDrawing(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stop()
    }
  }, [drawing, onBoxDrawn])

  const startBbox = layerBbox ?? draftBbox
  return (
    <div className="flex flex-col gap-3">
      <div className="relative h-[26rem] overflow-hidden rounded-md border border-line bg-surface">
        {onBoxDrawn ? (
          // Only the button takes pointer events: the rest of this overlay must not block a drag that
          // starts in the corner of the map.
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col items-start gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={drawing ? 'default' : 'outline'}
              className="pointer-events-auto"
              aria-pressed={drawing}
              onClick={() => {
                setAnnouncement(
                  drawing
                    ? 'Drawing cancelled.'
                    : 'Drawing mode on. Drag on the map to draw the box. Press Escape to cancel.',
                )
                setDrawing((on) => !on)
              }}
            >
              <SquareDashedMousePointer className="size-4" aria-hidden />
              Draw region
            </Button>
            <p
              role="status"
              className={
                drawing
                  ? 'pointer-events-none rounded bg-surface/95 px-2 py-1 text-xs text-ink shadow-sm'
                  : 'sr-only'
              }
            >
              {announcement}
            </p>
          </div>
        ) : null}
        <Map
          ref={mapRef}
          mapStyle={BASEMAP_STYLE_URL}
          initialViewState={
            startBbox
              ? { bounds: startBbox, fitBoundsOptions: { padding: FIT_PADDING } }
              : DEFAULT_VIEW
          }
          interactiveLayerIds={['stations']}
          cursor={pointer ? 'pointer' : undefined}
          onMouseEnter={() => {
            setPointer(true)
          }}
          onMouseLeave={() => {
            setPointer(false)
          }}
          onClick={(event) => {
            // A drag in drawing mode must not select (or deselect) a station.
            if (drawing) return
            const id: unknown = event.features?.[0]?.properties.id
            onSelect(typeof id === 'string' ? id : null)
          }}
        >
          <NavigationControl showCompass={false} />
          <Source id="region" type="geojson" data={region}>
            <Layer
              id="region-fill"
              type="fill"
              paint={{ 'fill-color': '#0a7570', 'fill-opacity': 0.06 }}
            />
            <Layer
              id="region-outline"
              type="line"
              paint={{ 'line-color': '#0a7570', 'line-width': 2, 'line-dasharray': [2, 2] }}
            />
          </Source>
          {showSyncedBox ? (
            <Source id="synced" type="geojson" data={syncedRegion}>
              <Layer
                id="synced-outline"
                type="line"
                paint={{ 'line-color': '#0a7570', 'line-width': 2 }}
              />
            </Source>
          ) : null}
          <Source id="stations" type="geojson" data={data}>
            <Layer id="stations" type="circle" paint={paint} />
            <Layer
              id="stations-selected"
              type="circle"
              filter={['==', ['get', 'id'], selectedId ?? '']}
              paint={{
                'circle-radius': 15,
                'circle-color': 'rgba(0, 0, 0, 0)',
                'circle-stroke-width': 3,
                'circle-stroke-color': '#0a7570',
              }}
            />
          </Source>
          {selected ? (
            <Popup
              longitude={selected.geometry.coordinates[0]}
              latitude={selected.geometry.coordinates[1]}
              maxWidth="320px"
              offset={16}
              closeOnClick={false}
              // Keep keyboard focus where it was (e.g. the list row) instead of jumping into the map.
              focusAfterOpen={false}
              onClose={() => {
                onSelect(null)
              }}
            >
              <StationPopup station={selected} now={now} />
            </Popup>
          ) : null}
        </Map>
      </div>
      {layer ? <Legend property={property} range={range} showSyncedBox={showSyncedBox} /> : null}
    </div>
  )
}
