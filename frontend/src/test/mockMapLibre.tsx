import { useImperativeHandle, type ReactNode, type Ref } from 'react'
import { FAKE_MAP, mapSpies } from './mapSpies'

/**
 * Stand-in for `react-map-gl/maplibre` in jsdom, which has no WebGL. It records what the app
 * hands to the map (sources, layers, popup) so tests assert on data and behaviour at that boundary,
 * never on pixels (docs/quality.md). Real rendering is verified in a browser.
 */
interface ClickEvent {
  features?: { properties?: Record<string, unknown> }[]
  point?: { x: number; y: number }
}

export function Map({
  children,
  onClick,
  onMouseMove,
  onMouseLeave,
  mapStyle,
  initialViewState,
  ref,
}: {
  children?: ReactNode
  onClick?: (event: ClickEvent) => void
  onMouseMove?: (event: ClickEvent & { point: { x: number; y: number } }) => void
  onMouseLeave?: () => void
  mapStyle?: string
  initialViewState?: unknown
  ref?: Ref<{ fitBounds: typeof mapSpies.fitBounds; getMap: () => unknown }>
}) {
  useImperativeHandle(ref, () => ({
    fitBounds: mapSpies.fitBounds,
    getMap: () => FAKE_MAP,
  }))
  return (
    <div
      data-testid="map"
      data-style={mapStyle}
      data-initial-view={JSON.stringify(initialViewState ?? null)}
    >
      {onClick ? (
        <>
          <button
            type="button"
            onClick={() => {
              onClick({ features: [{ properties: { id: 'f-1' } }] })
            }}
          >
            map: click first station
          </button>
          <button
            type="button"
            onClick={() => {
              onClick({ features: [] })
            }}
          >
            map: click empty ground
          </button>
        </>
      ) : null}
      {onMouseMove ? (
        <>
          <button
            type="button"
            onClick={() => {
              onMouseMove({ features: [{ properties: { id: 'f-1' } }], point: { x: 10, y: 20 } })
            }}
          >
            map: hover first station
          </button>
          <button
            type="button"
            onClick={() => {
              onMouseMove({ features: [], point: { x: 5, y: 5 } })
            }}
          >
            map: hover empty ground
          </button>
        </>
      ) : null}
      {onMouseLeave ? (
        <button type="button" onClick={onMouseLeave}>
          map: pointer leaves
        </button>
      ) : null}
      {children}
    </div>
  )
}

export function Source({
  id,
  data,
  children,
}: {
  id: string
  data: unknown
  children?: ReactNode
}) {
  return (
    <div data-testid={`source-${id}`} data-geojson={JSON.stringify(data)}>
      {children}
    </div>
  )
}

export function Layer({ id, paint, layout }: { id: string; paint?: unknown; layout?: unknown }) {
  return (
    <div
      data-testid={`layer-${id}`}
      data-paint={JSON.stringify(paint ?? {})}
      data-layout={JSON.stringify(layout ?? {})}
    />
  )
}

export function NavigationControl() {
  return null
}
