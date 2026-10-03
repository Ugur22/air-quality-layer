import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { Place } from './types'

export const MIN_QUERY_LENGTH = 3

export async function searchPlaces(text: string): Promise<Place[]> {
  const params = new URLSearchParams({ q: text })
  return (await apiFetch<{ places: Place[] }>(`/places?${params.toString()}`)).places
}

/**
 * Places matching `text` (already trimmed), searched only while `wanted` (the result list is open). The server caches too, but asking it again for
 * something just searched is pointless, so answers are kept for as long as the server keeps them.
 */
export function usePlaceSearch(text: string, wanted: boolean) {
  return useQuery({
    queryKey: ['places', text.toLowerCase()],
    queryFn: () => searchPlaces(text),
    enabled: wanted && text.length >= MIN_QUERY_LENGTH,
    staleTime: 10 * 60 * 1000,
    placeholderData: keepPreviousData,
  })
}
