import 'maplibre-gl/dist/maplibre-gl.css'
import type { MapboxOverlay } from '@deck.gl/mapbox'
import { Box, SquareDashedMousePointer } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Map, NavigationControl, Source, type MapRef } from 'react-map-gl/maplibre'
import type { Bbox } from '@/features/regions/types'
import { Button } from '@/components/ui/button'
import { BASEMAP_STYLE_URL } from '@/lib/config'
import { formatValue } from '@/lib/format'
import { useCountryBorder } from '@/features/national/borders'
import { DEFAULT_COUNTRY } from '@/features/national/types'
import {
  buildMapData,
  COLOUR_STOPS,
  guidelineClasses,
  HAS_VALUE_FILTER,
  NO_VALUE_FILTER,
  STATION_BADGE_LAYOUT,
  STATION_DOT_LAYOUT,
  STATION_EMPTY_PAINT,
  STATION_EMPTY_SELECTED_PAINT,
  STATION_SELECTED_PAINT,
  stationBadgePaint,
  stationDotPaint,
  valueRange,
} from './mapData'
import { addBadgeImage } from './badgeImage'
import { buildColumnLayers, COLUMN_PITCH, type MapView } from './columnLayer'
import { ColumnOverlay } from './ColumnOverlay'
import { startRectangleDrawing } from './regionDrawing'
import { StationTooltip } from './StationTooltip'
import type { MapLayerResponse } from './types'

// Room a tooltip needs next to the pointer before it would run off the map.
const TOOLTIP_ROOM = { width: 260, height: 100 }
// The legend floats over the bottom-left corner, so a fitted region leaves room under it.
const FIT_PADDING_BOX = { top: 48, right: 48, bottom: 120, left: 48 }
// A move to another place is a fly-over: the camera zooms out, travels and zooms back in
// (fitBounds without `linear` is MapLibre's flyTo). The time follows the distance, capped, and
// MapLibre skips the animation for users who prefer reduced motion.
const FLY_OVER = { speed: 1.1, maxDuration: 3500 }
// The Netherlands, west/south/east/north: where the map opens when there is neither a layer nor a
// box to look at. Nothing stops the user from going elsewhere (a place search moves the camera).
const NETHERLANDS_BOUNDS: Bbox = [3.3, 50.75, 7.25, 53.55]
// How far a tilted country view sits from the flat fit (negative is closer). Tilting makes the same
// zoom look much further out, so it goes closer; measured in a browser, not derived.
const TILT_ZOOM_OUT = -0.8
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
  const classes = range === null ? null : guidelineClasses(property, range.unit)
  return (
    <div
      role="group"
      aria-label="Map legend"
      className="absolute bottom-6 left-3 z-10 flex max-h-52 max-w-[min(17rem,calc(100%-1.5rem))] flex-col gap-1.5 overflow-y-auto rounded-lg border border-line bg-surface/95 p-3 text-xs text-muted shadow-md"
    >
      {property === null || range === null ? (
        <p>{property === null ? 'Nothing to colour by.' : `No station reports ${property}.`}</p>
      ) : classes !== null ? (
        <div className="flex flex-col gap-1">
          <p>
            Latest <span className="font-mono text-ink">{property}</span> reading ({range.unit})
            against WHO 2021 24-hour guideline levels
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {classes.map((c) => (
              <span key={c.label} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-3 rounded-full border border-ink/70"
                  style={{ background: c.colour }}
                />
                <span className="tabular-nums">{c.label}</span>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-ink">{property}</span>
          <span className="tabular-nums">{formatValue(range.min)}</span>
          <span
            aria-hidden
            className="h-2.5 w-24 rounded-full border border-line"
            style={{ background: `linear-gradient(to right, ${COLOUR_STOPS.join(', ')})` }}
          />
          <span className="tabular-nums">
            {formatValue(range.max)} {range.unit}
          </span>
          <span>(relative to this layer)</span>
        </div>
      )}
      {property !== null ? (
        <div className="flex flex-col gap-1">
          {classes === null ? (
            <p className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-grid h-5 min-w-9 place-items-center rounded-full bg-accent px-2 font-mono text-[11px] text-white"
              >
                12.4
              </span>
              Latest {property} reading
            </p>
          ) : null}
          <p className="flex items-center gap-2">
            <span
              aria-hidden
              className="mx-3.5 size-2.5 rounded-full border border-muted bg-line"
            />
            <span>No usable {property} value</span>
          </p>
        </div>
      ) : null}
      <details className="group">
        <summary className="cursor-pointer select-none text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          What the markers mean
        </summary>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {range !== null && range.otherUnitCount > 0 ? (
            <p>
              {range.otherUnitCount === 1
                ? `1 station reports ${String(property)} in another unit and is`
                : `${String(range.otherUnitCount)} stations report ${String(property)} in another unit and are`}{' '}
              left off this scale and drawn as a small grey dot; the popup shows the real value.
            </p>
          ) : null}
          <p>
            Pale badge: the reading is 24 hours old or older. Small grey dot: no usable value to
            colour. Where badges would overlap, the lower value shows as a dot until you zoom in.
          </p>
          {showSyncedBox ? (
            <p>
              Dashed box: the region in the form. Solid box: the region these stations come from.
            </p>
          ) : null}
        </div>
      </details>
    </div>
  )
}

/** Keeps the previous view while the camera has barely moved, so React does not re-render per frame. */
function nextView(previous: MapView, next: MapView): MapView {
  return Math.abs(previous.zoom - next.zoom) < 0.05 &&
    Math.abs(previous.latitude - next.latitude) < 0.1
    ? previous
    : next
}

function readView(map: { getZoom: () => number; getCenter: () => { lat: number } }): MapView {
  return { zoom: map.getZoom(), latitude: map.getCenter().lat }
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
  countryView = null,
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
  /**
   * The country the country view is on. Until its layer exists (loading, or not built yet) the map
   * shows that country's border and frames it, instead of the previous place with nothing in it.
   */
  countryView?: { code: string; bbox: Bbox } | null
}) {
  const mapRef = useRef<MapRef>(null)
  const overlayRef = useRef<MapboxOverlay>(null)
  const [columns, setColumns] = useState(false)
  // Column size follows the zoom, in steps small enough to look continuous.
  const [view, setView] = useState<MapView>({ zoom: 8, latitude: 52 })
  const [pointer, setPointer] = useState(false)
  // The station under the pointer and where, for the tooltip.
  const [hover, setHover] = useState<{
    id: string
    x: number
    y: number
    flipX: boolean
    flipY: boolean
  } | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [drawing, setDrawing] = useState(false)
  // The badge layers name an image that only exists after the style has loaded.
  const [badgeReady, setBadgeReady] = useState(false)
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
  const paint = useMemo(() => stationBadgePaint(range, property), [range, property])
  const dotPaint = useMemo(() => stationDotPaint(range, property), [range, property])
  const region = useMemo(() => (draftBbox ? outline(draftBbox) : EMPTY), [draftBbox])
  // After a sync the form can be edited away from the region the stations belong to; both are drawn.
  // The national layer's box is only a frame for the camera; drawing it would claim a region.
  const isNational = layer?.map_layer.region_id === null
  // The country's real border frames the stations; the stations themselves are still whatever the
  // sources returned, so none is dropped for lying just outside a simplified line.
  const shownCountry = layer
    ? isNational
      ? (layer.map_layer.country ?? DEFAULT_COUNTRY)
      : null
    : (countryView?.code ?? null)
  const border = useCountryBorder(shownCountry)
  const showSyncedBox = layerBbox !== null && !isNational && !sameBox(layerBbox, draftBbox)
  const syncedRegion = useMemo(
    () => (layerBbox && showSyncedBox ? outline(layerBbox) : EMPTY),
    [layerBbox, showSyncedBox],
  )
  const columnLayers = useMemo(
    () => (columns ? buildColumnLayers({ data, range, property, view, selectedId }) : []),
    [columns, data, range, property, view, selectedId],
  )
  /** The id of the station under a screen point: the style's layers, or deck.gl's columns. */
  const stationAt = (event: {
    point: { x: number; y: number }
    features?: { properties: Record<string, unknown> }[]
  }) => {
    if (!columns) return event.features?.[0]?.properties.id
    const picked = overlayRef.current?.pickObject({ x: event.point.x, y: event.point.y, radius: 4 })
    const props: unknown = (picked?.object as { properties?: { id?: unknown } } | undefined)
      ?.properties
    return (props as { id?: unknown } | undefined)?.id
  }
  const hovered = hover === null ? undefined : visible.find((s) => s.id === hover.id)

  // initialViewState frames the first view. When a sync finishes (or another one replaces it) the
  // camera moves to that region; typing in the form never moves the camera.
  const fittedFor = useRef(layer?.map_layer.id ?? null)
  const layerId = layer?.map_layer.id ?? null
  useEffect(() => {
    const map = mapRef.current
    if (layerId === null || layerId === fittedFor.current || !map || !layerBbox) return
    map.fitBounds(layerBbox, { padding: FIT_PADDING_BOX, ...FLY_OVER })
    fittedFor.current = layerId
  }, [layerId, layerBbox])

  // A country whose layer is not there yet is framed by the country's own box.
  const waitingFor = layer === null ? countryView : null
  const waitingCode = waitingFor?.code
  const waitingBbox = waitingFor?.bbox
  useEffect(() => {
    const map = mapRef.current
    if (!map || !waitingBbox) return
    map.fitBounds(waitingBbox, { padding: FIT_PADDING_BOX, ...FLY_OVER })
  }, [waitingCode, waitingBbox])

  // A chosen place moves the camera once; a request that was already there when the map appeared
  // (a remount) does not move it again.
  const lastViewId = useRef(viewRequest?.id ?? 0)
  useEffect(() => {
    const map = mapRef.current
    if (!viewRequest || viewRequest.id === lastViewId.current || !map) return
    map.fitBounds(viewRequest.bbox, { padding: FIT_PADDING_BOX, ...FLY_OVER })
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

  const startBbox = layerBbox ?? countryView?.bbox ?? draftBbox
  return (
    <div ref={frame} className="relative h-full overflow-hidden bg-surface">
      <div className="absolute inset-0">
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
              ? { bounds: startBbox, fitBoundsOptions: { padding: FIT_PADDING_BOX } }
              : { bounds: NETHERLANDS_BOUNDS, fitBoundsOptions: { padding: 16 } }
          }
          interactiveLayerIds={columns ? [] : ['stations', 'stations-dot', 'stations-empty']}
          onLoad={(event) => {
            addBadgeImage(event.target)
            setBadgeReady(true)
            setView(readView(event.target))
          }}
          // Followed during the move too: sized only at its end, the columns would keep the old
          // zoom's size for the whole fly-over and then jump.
          onMove={(event) => {
            setView((previous) => nextView(previous, readView(event.target)))
          }}
          onMoveEnd={(event) => {
            setView(readView(event.target))
          }}
          cursor={pointer ? 'pointer' : undefined}
          onMouseEnter={() => {
            setPointer(true)
          }}
          onMouseMove={(event) => {
            const id = stationAt(event)
            const { x, y } = event.point
            if (columns) setPointer(typeof id === 'string')
            // Near the right or bottom edge the tooltip goes to the other side of the pointer.
            const width = frame.current?.clientWidth ?? 0
            const height = frame.current?.clientHeight ?? 0
            setHover(
              typeof id === 'string' && !drawing
                ? {
                    id,
                    x,
                    y,
                    flipX: width > 0 && x + TOOLTIP_ROOM.width > width,
                    flipY: height > 0 && y + TOOLTIP_ROOM.height > height,
                  }
                : null,
            )
          }}
          onMouseLeave={() => {
            setPointer(false)
            setHover(null)
          }}
          onClick={(event) => {
            // A drag in drawing mode must not select (or deselect) a station.
            if (drawing) return
            setHover(null)
            const id = stationAt(event)
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
          {/* Always mounted, like the region box: a source added later would be drawn over the
              stations. */}
          <Source id="country" type="geojson" data={border ?? EMPTY}>
            <Layer
              id="country-fill"
              type="fill"
              paint={{ 'fill-color': '#0a7570', 'fill-opacity': 0.06 }}
            />
            <Layer
              id="country-outline"
              type="line"
              paint={{ 'line-color': '#0a7570', 'line-width': 2 }}
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
          {columns ? <ColumnOverlay layers={columnLayers} overlayRef={overlayRef} /> : null}
          {columns ? null : (
            <Source id="stations" type="geojson" data={data}>
              <Layer
                id="stations-selected"
                type="circle"
                filter={['all', HAS_VALUE_FILTER, ['==', ['get', 'id'], selectedId ?? '']]}
                paint={STATION_SELECTED_PAINT}
              />
              <Layer
                id="stations-empty-selected"
                type="circle"
                filter={['all', NO_VALUE_FILTER, ['==', ['get', 'id'], selectedId ?? '']]}
                paint={STATION_EMPTY_SELECTED_PAINT}
              />
              <Layer
                id="stations-dot"
                type="circle"
                filter={HAS_VALUE_FILTER}
                layout={STATION_DOT_LAYOUT}
                paint={dotPaint}
              />
              <Layer
                id="stations-empty"
                type="circle"
                filter={NO_VALUE_FILTER}
                paint={STATION_EMPTY_PAINT}
              />
              {badgeReady ? (
                <Layer
                  id="stations"
                  type="symbol"
                  filter={HAS_VALUE_FILTER}
                  layout={STATION_BADGE_LAYOUT}
                  paint={paint}
                />
              ) : null}
            </Source>
          )}
        </Map>
      </div>
      {layer && range ? (
        <Button
          type="button"
          size="sm"
          variant={columns ? 'default' : 'outline'}
          className="absolute right-3 top-24 z-10"
          aria-pressed={columns}
          onClick={() => {
            const pitch = columns ? 0 : COLUMN_PITCH
            const map = mapRef.current
            // Tilting alone pushes the far end of a country off the screen, and fitBounds at a
            // pitch zooms out far more than needed. So: fit flat, then step back a little.
            // A region keeps wherever the user has moved to.
            const fit =
              isNational && layerBbox
                ? map?.cameraForBounds(layerBbox, { padding: FIT_PADDING_BOX })
                : undefined
            if (map && fit?.center && fit.zoom !== undefined) {
              map.easeTo({
                pitch,
                center: fit.center,
                zoom: fit.zoom - (pitch > 0 ? TILT_ZOOM_OUT : 0),
                duration: 600,
              })
            } else {
              map?.easeTo({ pitch, duration: 600 })
            }
            setHover(null)
            setColumns((on) => !on)
          }}
        >
          <Box className="size-4" aria-hidden />
          Columns
        </Button>
      ) : null}
      {hovered && hover ? (
        <StationTooltip
          station={hovered}
          property={property}
          unit={range?.unit}
          now={now}
          x={hover.x}
          y={hover.y}
          flipX={hover.flipX}
          flipY={hover.flipY}
        />
      ) : null}
      {layer ? <Legend property={property} range={range} showSyncedBox={showSyncedBox} /> : null}
    </div>
  )
}
