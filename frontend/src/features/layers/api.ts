import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { LayerFilter } from './filter'
import type { MapLayerResponse } from './types'

export function getMapLayer(
  mapLayerId: string,
  filter: LayerFilter | null,
): Promise<MapLayerResponse> {
  const query = filter
    ? `?${new URLSearchParams({
        property: filter.property,
        value: filter.value,
        comparator: filter.comparator,
      }).toString()}`
    : ''
  return apiFetch<MapLayerResponse>(`/map-layers/${mapLayerId}${query}`)
}

export function useMapLayer(mapLayerId: string | null) {
  return useQuery({
    queryKey: ['map-layer', mapLayerId],
    queryFn: () => getMapLayer(mapLayerId ?? '', null),
    enabled: mapLayerId !== null,
  })
}

/**
 * The stations matching a filter. The server does the matching (the contract's filter), and each
 * feature keeps the id it has in the unfiltered layer, so the result is used as a set of ids.
 * The previous answer stays on screen while a new one loads.
 */
export function useFilteredMapLayer(mapLayerId: string | null, filter: LayerFilter | null) {
  return useQuery({
    queryKey: ['map-layer', mapLayerId, filter],
    queryFn: () => getMapLayer(mapLayerId ?? '', filter),
    enabled: mapLayerId !== null && filter !== null,
    placeholderData: keepPreviousData,
  })
}
