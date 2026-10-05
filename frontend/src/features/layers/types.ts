export interface Reading {
  value: number
  unit: string
  observed_at: string
  /** openaq | luchtmeetnet; absent on a layer stored before there was a second source. */
  source?: string
}

export interface StationFeature {
  type: 'Feature'
  id: string
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: {
    name: string
    sources?: string[]
    readings: Record<string, Reading>
    /** Client-only: set when several countries' layers are merged, never sent by the API. */
    country?: string
  }
}

export interface MapLayerResponse {
  map_layer: {
    id: string
    /** Null for the national layer, which belongs to no region (ADR 0018). */
    region_id: string | null
    /** Only a national layer names its country (ISO code, ADR 0019). */
    country?: string
    /** Only the national layer says when its refresh finished. */
    refreshed_at?: string
    station_count: number
    bbox: [number, number, number, number]
    property_keys: string[]
    /** Client-only: the country layers a merged layer is made of, never sent by the API. */
    parts?: { country: string; id: string }[]
  }
  stations: { type: 'FeatureCollection'; features: StationFeature[] }
}

export interface StationHistory {
  property: string
  /** Null when the station has no sensor for the property. */
  unit: string | null
  interval: 'hour'
  from: string
  to: string
  /** Hourly values, oldest first; `at` is the end of the hour a value covers. */
  points: { at: string; value: number }[]
}

export interface StationHistoryResponse {
  history: StationHistory
}
