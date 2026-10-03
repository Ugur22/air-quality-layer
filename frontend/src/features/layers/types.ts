export interface Reading {
  value: number
  unit: string
  observed_at: string
}

export interface StationFeature {
  type: 'Feature'
  id: string
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: { name: string; readings: Record<string, Reading> }
}

export interface MapLayerResponse {
  map_layer: {
    id: string
    region_id: string
    station_count: number
    bbox: [number, number, number, number]
    property_keys: string[]
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
