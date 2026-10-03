import { useImperativeHandle, type ReactNode, type Ref } from 'react'
import { FAKE_MAP, mapSpies } from './mapSpies'

/**
 * Stand-in for `react-map-gl/maplibre` in jsdom, which has no WebGL. It records what the app
 * hands to the map (sources, layers, popup) so tests assert on data and behaviour at that boundary,
 * never on pixels (docs/quality.md). Real rendering is verified in a browser.
 */
interface ClickEvent {
  features?: { properties?: Record<string, unknown> }[]
}

export function Map({
  children,
  onClick,
  mapStyle,
  ref,
}: {
  children?: ReactNode
  onClick?: (event: ClickEvent) => void
  mapStyle?: string
  ref?: Ref<{ fitBounds: typeof mapSpies.fitBounds; getMap: () => unknown }>
}) {
  useImperativeHandle(ref, () => ({
    fitBounds: mapSpies.fitBounds,
    getMap: () => FAKE_MAP,
  }))
  return (
    <div data-testid="map" data-style={mapStyle}>
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

export function Popup({
  children,
  onClose,
  longitude,
  latitude,
}: {
  children?: ReactNode
  onClose?: () => void
  longitude?: number
  latitude?: number
}) {
  return (
    <div
      role="dialog"
      aria-label="Station details"
      data-longitude={longitude}
      data-latitude={latitude}
    >
      {children}
      <button type="button" onClick={onClose}>
        popup: close
      </button>
    </div>
  )
}

export function NavigationControl() {
  return null
}
