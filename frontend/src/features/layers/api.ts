import { keepPreviousData, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { mergeLayers } from '@/features/national/compare'
import { apiFetch } from '@/lib/api'
import type { LayerFilter } from './filter'
import type { MapLayerResponse, StationHistoryResponse } from './types'

/**
 * A national layer is read from its own endpoint, by country; its id is not a sync job (ADR 0018,
 * 0019). `country` is null for a region layer.
 */
export function getMapLayer(
  mapLayerId: string,
  filter: LayerFilter | null,
  country: string | null = null,
): Promise<MapLayerResponse> {
  const params = new URLSearchParams()
  if (country) params.set('country', country)
  if (filter) {
    params.set('property', filter.property)
    params.set('value', filter.value)
    params.set('comparator', filter.comparator)
  }
  const query = params.size > 0 ? `?${params.toString()}` : ''
  return apiFetch<MapLayerResponse>(
    country ? `/national-layer${query}` : `/map-layers/${mapLayerId}${query}`,
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

function combineNational(results: UseQueryResult<MapLayerResponse>[]) {
  return {
    /** The layers that have loaded, as one; its parts keep the order the countries were asked in. */
    layer: mergeLayers(results.flatMap((r) => (r.data ? [r.data] : []))),
    /** Per country, in the order asked: its own layer, or null while it has none. */
    layers: results.map((r) => r.data ?? null),
    errors: results.map((r) => r.error),
    loading: results.some((r) => r.isLoading),
    updatedAt: Math.max(0, ...results.map((r) => r.dataUpdatedAt)),
  }
}

/**
 * Whole-country layers, one per code. The server rebuilds each hourly, so they are asked again now
 * and then for as long as the view is open rather than only once.
 */
export function useNationalLayers(countries: string[], enabled: boolean) {
  return useQueries({
    queries: countries.map((country) => ({
      queryKey: ['national-layer', country],
      queryFn: () => getMapLayer('', null, country),
      enabled,
      refetchInterval: NATIONAL_REFETCH_MS,
    })),
    combine: combineNational,
  })
}

type FilterPart = { id: string; country: string | null } | undefined

function useFilteredLayerSlot(part: FilterPart, filter: LayerFilter | null) {
  return useQuery({
    queryKey: ['map-layer', part?.id ?? null, filter],
    queryFn: () => getMapLayer(part?.id ?? '', filter, part?.country ?? null),
    enabled: part !== undefined && filter !== null,
    // The previous answer stays on screen while a new one loads.
    placeholderData: keepPreviousData,
  })
}

/**
 * The stations matching a filter in each of up to two layers (a country each, or one region layer;
 * `country: null` is a region layer). Two fixed slots rather than `useQueries`, because only a
 * single observer keeps its previous answer when the filter changes. Answers are per part, so the
 * caller checks each against the layer it is shown for.
 */
export function useFilteredLayerParts(parts: FilterPart[], filter: LayerFilter | null) {
  const first = useFilteredLayerSlot(parts[0], filter)
  const second = useFilteredLayerSlot(parts[1], filter)
  return [first, second].slice(0, Math.max(1, parts.length))
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
