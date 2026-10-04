import { describe, expect, it } from 'vitest'
import { buildColumnLayers, columnBasis } from './columnLayer'
import type { MapStationCollection } from './mapData'

const feature = (id: string, value: number | null, stale = false) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [4.9, 52.37] as [number, number] },
  properties: { id, name: id, hasValue: value !== null, value, label: '', stale },
})
const data: MapStationCollection = {
  type: 'FeatureCollection',
  features: [feature('a', 7.6), feature('b', 36.4, true), feature('c', null)],
}
const range = { min: 7.6, max: 36.4, unit: 'µg/m³', otherUnitCount: 0 }

function build(selectedId: string | null = null) {
  const layers = buildColumnLayers({
    data,
    range,
    property: 'pm25',
    bbox: [4.85, 52.35, 4.95, 52.4],
    selectedId,
  })
  const byId = (id: string) => layers.find((l) => l.id === id)
  return { byId }
}

describe('columnBasis', () => {
  it('is the box itself up to a province, then grows more slowly', () => {
    expect(columnBasis(20_000)).toBe(20_000)
    expect(columnBasis(50_000)).toBe(50_000)
    // A country-sized box (about 430 km across) is not 8.6 times a province-sized one.
    expect(columnBasis(430_000)).toBeLessThan(160_000)
    expect(columnBasis(430_000)).toBeGreaterThan(columnBasis(200_000))
  })
})

describe('buildColumnLayers', () => {
  it('draws a column per station with a value and a grey dot for the others', () => {
    const { byId } = build()

    expect(byId('columns')?.props.data).toHaveLength(2)
    expect(byId('columns-empty')?.props.data).toHaveLength(1)
  })

  it('makes a column twice as high for twice the reading', () => {
    const column = build().byId('columns')?.props as unknown as {
      getElevation: (s: ReturnType<typeof feature>) => number
    }

    expect(column.getElevation(feature('x', 20))).toBeCloseTo(
      2 * column.getElevation(feature('y', 10)),
    )
  })

  it('colours by WHO class and fades a stale reading', () => {
    const column = build().byId('columns')?.props as unknown as {
      getFillColor: (s: ReturnType<typeof feature>) => number[]
    }

    expect(column.getFillColor(feature('x', 7.6))).toEqual([255, 255, 178, 255])
    expect(column.getFillColor(feature('y', 36.4, true))).toEqual([253, 141, 60, 140])
  })

  it('adds a halo column only for the selected station', () => {
    expect(build().byId('columns-selected')?.props.data).toHaveLength(0)
    expect(build('b').byId('columns-selected')?.props.data).toHaveLength(1)
  })
})
