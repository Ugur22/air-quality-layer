export interface Country {
  /** ISO 3166-1 alpha-2, upper case. */
  code: string
  name: string
  bbox: [number, number, number, number]
  /** Null until a refresh of this country has succeeded. */
  refreshed_at: string | null
  station_count: number | null
}

export const DEFAULT_COUNTRY = 'NL'
