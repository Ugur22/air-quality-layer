import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { Country } from './types'

const COUNTRIES_STALE_MS = 5 * 60 * 1000

/** The countries that have a national layer (ADR 0019); fixed data on the server, so rarely asked. */
export function useCountries(enabled: boolean) {
  return useQuery({
    queryKey: ['countries'],
    queryFn: () => apiFetch<{ countries: Country[] }>('/countries').then((r) => r.countries),
    enabled,
    staleTime: COUNTRIES_STALE_MS,
  })
}
