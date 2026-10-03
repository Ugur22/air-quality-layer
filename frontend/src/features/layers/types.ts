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
