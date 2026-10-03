import 'maplibre-gl/dist/maplibre-gl.css'
import { SquareDashedMousePointer } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Map, NavigationControl, Source, type MapRef } from 'react-map-gl/maplibre'
import type { Bbox } from '@/features/regions/types'
import { Button } from '@/components/ui/button'
import { BASEMAP_STYLE_URL } from '@/lib/config'
import { formatValue } from '@/lib/format'
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
import { startRectangleDrawing } from './regionDrawing'
import { StationTooltip } from './StationTooltip'
import type { MapLayerResponse } from './types'

// Room a tooltip needs next to the pointer before it would run off the map.
const TOOLTIP_ROOM = { width: 260, height: 100 }
// The legend floats over the bottom-left corner, so a fitted region leaves room under it.
const FIT_PADDING_BOX = { top: 48, right: 48, bottom: 120, left: 48 }
// The Netherlands, west/south/east/north: where the map opens when there is neither a layer nor a
// box to look at. Nothing stops the user from going elsewhere (a place search moves the camera).
const NETHERLANDS_BOUNDS: Bbox = [3.3, 50.75, 7.25, 53.55]
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
  const showSyncedBox = layerBbox !== null && !sameBox(layerBbox, draftBbox)
  const syncedRegion = useMemo(
    () => (layerBbox && showSyncedBox ? outline(layerBbox) : EMPTY),
    [layerBbox, showSyncedBox],
  )
  const hovered = hover === null ? undefined : visible.find((s) => s.id === hover.id)

  // initialViewState frames the first view. When a sync finishes (or another one replaces it) the
  // camera moves to that region; typing in the form never moves the camera.
  const fittedFor = useRef(layer?.map_layer.id ?? null)
  const layerId = layer?.map_layer.id ?? null
  useEffect(() => {
    const map = mapRef.current
    if (layerId === null || layerId === fittedFor.current || !map || !layerBbox) return
    map.fitBounds(layerBbox, { padding: FIT_PADDING_BOX, duration: 0 })
    fittedFor.current = layerId
  }, [layerId, layerBbox])

  // A chosen place moves the camera once; a request that was already there when the map appeared
  // (a remount) does not move it again.
  const lastViewId = useRef(viewRequest?.id ?? 0)
  useEffect(() => {
    const map = mapRef.current
    if (!viewRequest || viewRequest.id === lastViewId.current || !map) return
    map.fitBounds(viewRequest.bbox, { padding: FIT_PADDING_BOX, duration: 600 })
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
          interactiveLayerIds={['stations', 'stations-dot', 'stations-empty']}
          onLoad={(event) => {
            addBadgeImage(event.target)
            setBadgeReady(true)
          }}
          cursor={pointer ? 'pointer' : undefined}
          onMouseEnter={() => {
            setPointer(true)
          }}
          onMouseMove={(event) => {
            const id: unknown = event.features?.[0]?.properties.id
            const { x, y } = event.point
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
        </Map>
      </div>
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
