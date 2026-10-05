import { describe, expect, it } from 'vitest'
import { layer } from '@/test/fixtures'
import type { MapLayerResponse, Reading, StationFeature } from '@/features/layers/types'
import { mergeLayers, summarise, unionBbox } from './compare'

const NOW = new Date('2026-10-03T10:00:00Z')

function station(
  id: string,
  value: number | null,
  observedAt = '2026-10-03T09:00:00Z',
): StationFeature {
  const readings: Record<string, Reading> =
    value === null ? {} : { pm25: { value, unit: 'µg/m³', observed_at: observedAt } }
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { name: id, readings },
  }
}

function national(country: string, id: string, ids: string[]): MapLayerResponse {
  return {
    map_layer: {
      ...layer.map_layer,
      id,
      region_id: null,
      country,
      refreshed_at: id === 'a' ? '2026-10-03T09:00:00Z' : '2026-10-03T08:00:00Z',
      station_count: ids.length,
      bbox: country === 'NL' ? [3, 50, 7, 54] : [6, 47, 15, 55],
      property_keys: country === 'NL' ? ['pm25'] : ['no2', 'pm25'],
    },
    stations: { type: 'FeatureCollection', features: ids.map((i) => station(i, 1)) },
  }
}

describe('summarise', () => {
  it('gives mean, median, lowest and highest over stations with a fresh reading', () => {
    const result = summarise(
      [station('a', 10), station('b', 20), station('c', 60), station('d', null)],
      'pm25',
      NOW,
    )

    expect(result).toMatchObject({
      stations: 4,
      reporting: 3,
      mean: 30,
      median: 20,
      min: 10,
      max: 60,
      unit: 'µg/m³',
    })
  })

  it('averages the two middle values for an even count', () => {
    expect(summarise([station('a', 1), station('b', 4)], 'pm25', NOW).median).toBe(2.5)
  })

  it('leaves out a stale reading instead of letting it pull the figures', () => {
    const result = summarise(
      [station('a', 10), station('b', 500, '2026-02-18T14:00:00Z')],
      'pm25',
      NOW,
    )

    expect(result).toMatchObject({ stations: 2, reporting: 1, mean: 10, max: 10 })
  })

  it('has no figures when nothing reports', () => {
    expect(summarise([station('a', null)], 'pm25', NOW)).toMatchObject({
      reporting: 0,
      mean: null,
      median: null,
      min: null,
      max: null,
      unit: null,
    })
  })
})

describe('unionBbox', () => {
  it('covers every box, and is null for none', () => {
    expect(
      unionBbox([
        [3, 50, 7, 54],
        [6, 47, 15, 55],
      ]),
    ).toEqual([3, 47, 15, 55])
    expect(unionBbox([])).toBeNull()
  })
})

describe('mergeLayers', () => {
  const nl = national('NL', 'a', ['n-1'])
  const de = national('DE', 'b', ['d-1', 'd-2'])

  it('is null without layers and keeps a single layer as it is, plus its part', () => {
    expect(mergeLayers([])).toBeNull()
    const one = mergeLayers([nl])
    expect(one?.map_layer.parts).toEqual([{ country: 'NL', id: 'a' }])
    expect(one?.stations.features).toHaveLength(1)
  })

  it('joins stations, tags each with its country and unions keys, box and counts', () => {
    const merged = mergeLayers([nl, de])

    expect(merged?.map_layer).toMatchObject({
      id: 'a+b',
      region_id: null,
      station_count: 3,
      bbox: [3, 47, 15, 55],
      property_keys: ['pm25', 'no2'],
      parts: [
        { country: 'NL', id: 'a' },
        { country: 'DE', id: 'b' },
      ],
    })
    expect(merged?.stations.features.map((f) => [f.id, f.properties.country])).toEqual([
      ['n-1', 'NL'],
      ['d-1', 'DE'],
      ['d-2', 'DE'],
    ])
  })

  it('is only as fresh as its older refresh', () => {
    expect(mergeLayers([nl, de])?.map_layer.refreshed_at).toBe('2026-10-03T08:00:00Z')
  })
})
