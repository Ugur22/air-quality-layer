import type { Layer } from '@deck.gl/core'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { useImperativeHandle, type Ref } from 'react'
import { useControl } from 'react-map-gl/maplibre'

/** Draws deck.gl layers on top of the basemap; the parent picks through the ref. */
export function ColumnOverlay({
  layers,
  overlayRef,
}: {
  layers: Layer[]
  overlayRef: Ref<MapboxOverlay>
}) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay({ interleaved: false, layers }))
  overlay.setProps({ layers })
  useImperativeHandle(overlayRef, () => overlay, [overlay])
  return null
}
