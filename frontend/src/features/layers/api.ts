import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { LayerFilter } from './filter'
import type { MapLayerResponse, StationHistoryResponse } from './types'

/** The national layer is read from its own endpoint; its id is not a sync job (ADR 0018). */
export function getMapLayer(
  mapLayerId: string,
  filter: LayerFilter | null,
  national = false,
): Promise<MapLayerResponse> {
  const query = filter
    ? `?${new URLSearchParams({
        property: filter.property,
        value: filter.value,
        comparator: filter.comparator,
      }).toString()}`
    : ''
  return apiFetch<MapLayerResponse>(
    national ? `/national-layer${query}` : `/map-layers/${mapLayerId}${query}`,
  )
}

export function useMapLayer(mapLayerId: string | null) {
  return useQuery({
    queryKey: ['map-layer', mapLayerId],
    queryFn: () => getMapLayer(mapLayerId ?? '', null),
    enabled: mapLayerId !== null,
  })
}

const NATIONAL_REFETCH_MS = 10 * 60 * 1000

/**
 * The whole-country layer. The server rebuilds it hourly, so it is asked again now and then for
 * as long as the view is open rather than only once.
 */
export function useNationalLayer(enabled: boolean) {
  return useQuery({
    queryKey: ['national-layer'],
    queryFn: () => getMapLayer('', null, true),
    enabled,
    refetchInterval: NATIONAL_REFETCH_MS,
  })
}

/**
 * The stations matching a filter. The server does the matching (the contract's filter), and each
 * feature keeps the id it has in the unfiltered layer, so the result is used as a set of ids.
 * The previous answer stays on screen while a new one loads.
 */
export function useFilteredMapLayer(
  mapLayerId: string | null,
  filter: LayerFilter | null,
  national = false,
) {
  return useQuery({
    queryKey: ['map-layer', mapLayerId, filter],
    queryFn: () => getMapLayer(mapLayerId ?? '', filter, national),
    enabled: mapLayerId !== null && filter !== null,
    placeholderData: keepPreviousData,
  })
}

export const HISTORY_HOURS = 24
const HISTORY_STALE_MS = 5 * 60 * 1000

/**
 * The last hours of one pollutant at one station, fetched from OpenAQ by the server when asked
 * (ADR 0014). `enabled` keeps it from being asked until the trend is actually looked at, because
 * every miss spends two calls of the shared OpenAQ rate limit.
 */
export function useStationHistory(
  mapLayerId: string,
  stationId: string,
  property: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['station-history', mapLayerId, stationId, property, HISTORY_HOURS],
    queryFn: () =>
      apiFetch<StationHistoryResponse>(
        `/map-layers/${mapLayerId}/stations/${stationId}/history?${new URLSearchParams({
          property: property ?? '',
          hours: String(HISTORY_HOURS),
        }).toString()}`,
      ).then((r) => r.history),
    enabled: enabled && property !== null,
    // The server caches for 5 minutes; asking again sooner would only repeat its answer.
    staleTime: HISTORY_STALE_MS,
  })
}
