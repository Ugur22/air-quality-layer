export interface SyncError {
  code: string
  message: string
}

export interface SyncJob {
  id: string
  region_id: string
  /** queued | processing | succeeded | failed; typed as string because new values must not crash. */
  status: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  station_count: number | null
  map_layer_id: string | null
  errors: SyncError[]
  /** Only on a succeeded job that is missing part of its data. */
  warnings?: SyncError[]
}
