import type { RegionFormValues } from '@/features/regions/validation'
import type { MapLayerResponse } from '@/features/layers/types'
import type { Region } from '@/features/regions/types'
import type { SyncJob } from '@/features/syncs/types'

export const project = { id: '00000000-0000-4000-8000-0000000000b1', name: 'Development project' }

export const region: Region = {
  id: 'r-1',
  project_id: project.id,
  name: 'Amsterdam centre',
  bbox: [4.85, 52.35, 4.95, 52.4],
  created_at: '2026-10-03T09:00:00Z',
}

export function syncJob(overrides: Partial<SyncJob> = {}): SyncJob {
  return {
    id: 'job-1',
    region_id: region.id,
    status: 'queued',
    created_at: '2026-10-03T09:00:00Z',
    started_at: null,
    finished_at: null,
    station_count: null,
    map_layer_id: null,
    errors: [],
    ...overrides,
  }
}

export const succeededJob = syncJob({
  status: 'succeeded',
  station_count: 12,
  map_layer_id: 'job-1',
  started_at: '2026-10-03T09:00:01Z',
  finished_at: '2026-10-03T09:00:05Z',
})

export const layer: MapLayerResponse = {
  map_layer: {
    id: 'job-1',
    region_id: region.id,
    station_count: 2,
    bbox: region.bbox,
    property_keys: ['no2', 'pm25'],
  },
  stations: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'f-1',
        geometry: { type: 'Point', coordinates: [4.88, 52.39] },
        properties: {
          name: 'Amsterdam-Van Diemenstraat',
          readings: {
            pm25: { value: 7.6, unit: 'µg/m³', observed_at: '2026-10-03T08:00:00Z' },
            no2: { value: 37.9, unit: 'µg/m³', observed_at: '2026-10-03T08:00:00Z' },
          },
        },
      },
      {
        type: 'Feature',
        id: 'f-2',
        geometry: { type: 'Point', coordinates: [4.9, 52.37] },
        properties: {
          name: 'Amsterdam City Center',
          readings: {
            pm25: { value: 36.4, unit: 'µg/m³', observed_at: '2026-02-18T14:00:00Z' },
          },
        },
      },
    ],
  },
}

/** A filled-in form (central Amsterdam). The app itself opens with no area chosen. */
export const amsterdamDraft: RegionFormValues = {
  name: 'Amsterdam centre',
  minLon: '4.85',
  minLat: '52.35',
  maxLon: '4.95',
  maxLat: '52.40',
}
