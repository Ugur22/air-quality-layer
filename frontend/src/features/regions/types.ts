/** [min_lon, min_lat, max_lon, max_lat] in WGS84, as in docs/api-contracts.md. */
export type Bbox = [number, number, number, number]

export interface Region {
  id: string
  project_id: string
  name: string
  bbox: Bbox
  created_at: string
}
