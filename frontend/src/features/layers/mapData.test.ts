import { describe, expect, it } from 'vitest'
import { layer } from '@/test/fixtures'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import type { StationFeature } from './types'
import { buildMapData, pickColourProperty, stationCirclePaint, valueRange } from './mapData'

const now = new Date('2026-10-03T10:00:00Z')
const stations = layer.stations.features

describe('pickColourProperty', () => {
  it('prefers pm25 when the layer has it', () => {
    expect(pickColourProperty(['no2', 'pm25'])).toBe('pm25')
  })

  it('falls back to the first property', () => {
    expect(pickColourProperty(['no2', 'o3'])).toBe('no2')
  })

  it('has nothing to colour by when the layer has no properties', () => {
    expect(pickColourProperty([])).toBeNull()
  })
})

describe('buildMapData', () => {
  it('flattens one property per station, because map styles cannot read nested objects', () => {
    const data = buildMapData(stations, 'pm25', now)

    expect(data.features.map((f) => f.properties)).toEqual([
      {
        id: 'f-1',
        name: 'Amsterdam-Van Diemenstraat',
        hasValue: true,
        value: 7.6,
        label: '7.6',
        stale: false,
      },
      {
        id: 'f-2',
        name: 'Amsterdam City Center',
        hasValue: true,
        value: 36.4,
        label: '36.4',
        stale: true,
      },
    ])
  })

  it('keeps geometry as [longitude, latitude]', () => {
    const data = buildMapData(stations, 'pm25', now)

    expect(data.features[0]?.geometry.coordinates).toEqual([4.88, 52.39])
  })

  it('marks a station without the property as having no value instead of dropping it', () => {
    const data = buildMapData(stations, 'no2', now)

    expect(data.features[1]?.properties).toMatchObject({ id: 'f-2', hasValue: false })
    expect(data.features).toHaveLength(2)
  })

  it('judges staleness by the reading of the chosen property, not the station', () => {
    const mixed = [
      {
        ...stations[0],
        properties: {
          name: 'Mixed',
          readings: {
            pm25: { value: 5, unit: 'µg/m³', observed_at: '2026-10-03T08:00:00Z' },
            pm10: { value: 58, unit: 'µg/m³', observed_at: '2025-01-13T23:00:00Z' },
          },
        },
      },
    ] as typeof stations

    expect(buildMapData(mixed, 'pm25', now).features[0]?.properties.stale).toBe(false)
    expect(buildMapData(mixed, 'pm10', now).features[0]?.properties.stale).toBe(true)
  })

  it('returns an empty collection for no stations or no property', () => {
    expect(buildMapData([], 'pm25', now).features).toEqual([])
    expect(buildMapData(stations, null, now).features.every((f) => !f.properties.hasValue)).toBe(
      true,
    )
  })
})

describe('buildMapData labels', () => {
  it('labels a station with its value, trimmed of float noise', () => {
    const noisy = structuredClone(stations)
    const reading = noisy[0]?.properties.readings.pm25
    if (reading) reading.value = 36.44749984741211

    expect(buildMapData(noisy, 'pm25', now).features[0]?.properties.label).toBe('36.45')
  })

  it('labels a station without a usable value with an en dash', () => {
    const data = buildMapData(stations, 'no2', now)

    expect(data.features[1]?.properties.label).toBe('–')
  })
})

describe('buildMapData with a colour scale taken from the whole layer', () => {
  it('judges the unit by the whole layer, not by the stations left after filtering', () => {
    const mixed = [
      station('a', { o3: { value: 10, unit: 'µg/m³' } }),
      station('b', { o3: { value: 20, unit: 'µg/m³' } }),
      station('c', { o3: { value: 0.05, unit: 'ppm' } }),
    ]

    // Filtered down to the lone ppm station, it is still the odd one out of the layer.
    const data = buildMapData([mixed[2] as StationFeature], 'o3', now, mixed)

    expect(data.features[0]?.properties.hasValue).toBe(false)
  })
})

describe('valueRange', () => {
  it('spans the stations that have the property', () => {
    expect(valueRange(stations, 'pm25')).toEqual({
      min: 7.6,
      max: 36.4,
      unit: 'µg/m³',
      otherUnitCount: 0,
    })
  })

  it('is null when no station has the property', () => {
    expect(valueRange(stations, 'o3')).toBeNull()
    expect(valueRange(stations, null)).toBeNull()
  })

  it('handles a single station, where min equals max', () => {
    expect(valueRange(stations.slice(0, 1), 'pm25')).toEqual({
      min: 7.6,
      max: 7.6,
      unit: 'µg/m³',
      otherUnitCount: 0,
    })
  })
})

function station(
  id: string,
  readings: Record<string, { value: number; unit: string }>,
): StationFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [4.9, 52.37] },
    properties: {
      name: id,
      readings: Object.fromEntries(
        Object.entries(readings).map(([k, r]) => [
          k,
          { ...r, observed_at: '2026-10-03T08:00:00Z' },
        ]),
      ),
    },
  }
}

describe('a parameter reported in different units', () => {
  const mixed = [
    station('a', { o3: { value: 10, unit: 'µg/m³' } }),
    station('b', { o3: { value: 20, unit: 'µg/m³' } }),
    station('c', { o3: { value: 0.05, unit: 'ppm' } }),
  ]

  it('scales by the most common unit only and counts the stations left out', () => {
    expect(valueRange(mixed, 'o3')).toEqual({ min: 10, max: 20, unit: 'µg/m³', otherUnitCount: 1 })
  })

  it('draws a station in another unit as a hollow ring instead of on the wrong scale', () => {
    const data = buildMapData(mixed, 'o3', now)

    expect(data.features.map((f) => f.properties.hasValue)).toEqual([true, true, false])
  })

  it('breaks a tie in favour of the unit seen first', () => {
    const tie = [
      station('a', { o3: { value: 1, unit: 'ppm' } }),
      station('b', { o3: { value: 9, unit: 'µg/m³' } }),
    ]

    expect(valueRange(tie, 'o3')?.unit).toBe('ppm')
  })

  it('reports no stations left out when everything shares one unit', () => {
    expect(valueRange(stations, 'pm25')?.otherUnitCount).toBe(0)
  })
})

describe('stationCirclePaint', () => {
  // The style validator is MapLibre's own, so an invalid expression fails here without a browser.
  function problems(range: ReturnType<typeof valueRange>) {
    return validateStyleMin({
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [{ id: 'stations', type: 'circle', source: 's', paint: stationCirclePaint(range) }],
    })
  }
  const base = { unit: 'µg/m³', otherUnitCount: 0 }

  it.each([
    ['a normal range', { min: 7.6, max: 36.4, ...base }],
    ['a single value (min equals max)', { min: 5, max: 5, ...base }],
    ['no range at all', null],
    ['a range one float step wide', { min: 1, max: 1 + Number.EPSILON, ...base }],
    ['negative values', { min: -3, max: 2, ...base }],
  ])('is a valid MapLibre style for %s', (_label, range) => {
    expect(problems(range)).toEqual([])
  })

  it('interpolates between ascending stops when values differ', () => {
    const color = stationCirclePaint({ min: 0, max: 10, ...base })?.['circle-color'] as unknown[]
    const interpolate = color[2] as unknown[]

    expect(interpolate[0]).toBe('interpolate')
    expect([interpolate[3], interpolate[5], interpolate[7]]).toEqual([0, 5, 10])
  })

  it.each([
    ['min equals max', { min: 5, max: 5, ...base }],
    ['a range one float step wide', { min: 1, max: 1 + Number.EPSILON, ...base }],
  ])('falls back to one colour for %s instead of an invalid scale', (_label, range) => {
    const color = stationCirclePaint(range)?.['circle-color'] as unknown[]

    expect(JSON.stringify(color)).not.toContain('interpolate')
  })

  it('fades stale readings and rings stations without a value', () => {
    const paint = stationCirclePaint({ min: 0, max: 10, ...base })

    expect(JSON.stringify(paint?.['circle-opacity'])).toContain('stale')
    expect(JSON.stringify(paint?.['circle-color'])).toContain('hasValue')
  })
})
