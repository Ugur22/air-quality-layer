import { describe, expect, it } from 'vitest'
import { buildColumnLayers, metresPerPixel } from './columnLayer'
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
    view: { zoom: 11, latitude: 52.37 },
    selectedId,
  })
  const byId = (id: string) => layers.find((l) => l.id === id)
  return { byId }
}

describe('metresPerPixel', () => {
  it('halves with every zoom level and shrinks towards the poles', () => {
    const at = (zoom: number, latitude = 0) => metresPerPixel({ zoom, latitude })
    expect(at(11)).toBeCloseTo(at(10) / 2)
    expect(at(10, 60)).toBeCloseTo(at(10) / 2)
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
