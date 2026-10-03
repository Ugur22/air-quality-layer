import type { Map as MapLibreMap } from 'maplibre-gl'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Everything outside our own code is replaced, so these tests cover how the app wires terra-draw
// up and tears it down. That the library draws and the map pans is checked in a real browser
// (e2e/drawing.spec.ts).
type Handler = (...args: unknown[]) => void
const handlers = new Map<string, Handler>()
const draw = {
  on: vi.fn((event: string, handler: Handler) => {
    handlers.set(event, handler)
  }),
  start: vi.fn(),
  stop: vi.fn(),
  setMode: vi.fn(),
  clear: vi.fn(),
  getSnapshot: vi.fn(),
}
vi.mock('terra-draw', () => ({
  TerraDraw: vi.fn(function () {
    return draw
  }),
  TerraDrawRectangleMode: vi.fn(),
}))
vi.mock('terra-draw-maplibre-gl-adapter', () => ({ TerraDrawMapLibreGLAdapter: vi.fn() }))

const { TerraDraw } = await import('terra-draw')
const { startRectangleDrawing } = await import('./regionDrawing')

function fakeMap(opts: { styleLoaded?: boolean; dragPan?: boolean; dragRotate?: boolean } = {}) {
  const map = {
    isStyleLoaded: vi.fn(() => opts.styleLoaded ?? true),
    once: vi.fn(),
    off: vi.fn(),
    dragPan: { isEnabled: vi.fn(() => opts.dragPan ?? true), enable: vi.fn() },
    dragRotate: { isEnabled: vi.fn(() => opts.dragRotate ?? true), enable: vi.fn() },
  }
  return { map, typed: map as unknown as MapLibreMap }
}

const rectangle = (id: string, ring: number[][]) => ({
  id,
  geometry: { type: 'Polygon', coordinates: [ring] },
})
const RING = [
  [4.85, 52.35],
  [4.95, 52.35],
  [4.95, 52.4],
  [4.85, 52.4],
  [4.85, 52.35],
]

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
})

describe('startRectangleDrawing', () => {
  it('switches to rectangle mode once the library says it is ready', () => {
    startRectangleDrawing(fakeMap().typed, vi.fn())

    expect(draw.start).toHaveBeenCalledTimes(1)
    expect(draw.setMode).not.toHaveBeenCalled()
    handlers.get('ready')?.()
    expect(draw.setMode).toHaveBeenCalledWith('rectangle')
  })

  it('hands over the box of a finished rectangle and removes the drawn shape', () => {
    const onFinish = vi.fn()
    draw.getSnapshot.mockReturnValue([rectangle('r1', RING)])
    startRectangleDrawing(fakeMap().typed, onFinish)

    handlers.get('finish')?.('r1')

    expect(onFinish).toHaveBeenCalledWith([4.85, 52.35, 4.95, 52.4])
    expect(draw.clear).toHaveBeenCalled()
  })

  it.each([
    [
      'no width',
      [
        [4.9, 52.35],
        [4.9, 52.35],
        [4.9, 52.4],
        [4.9, 52.4],
        [4.9, 52.35],
      ],
    ],
    [
      'no height',
      [
        [4.85, 52.4],
        [4.95, 52.4],
        [4.95, 52.4],
        [4.85, 52.4],
        [4.85, 52.4],
      ],
    ],
  ])('does not overwrite a good box with a rectangle that has %s', (_label, ring) => {
    const onFinish = vi.fn()
    draw.getSnapshot.mockReturnValue([rectangle('r1', ring)])
    startRectangleDrawing(fakeMap().typed, onFinish)

    handlers.get('finish')?.('r1')

    expect(onFinish).not.toHaveBeenCalled()
    expect(draw.clear).toHaveBeenCalled()
  })

  it('ignores a finished feature that is not a polygon or is unknown', () => {
    const onFinish = vi.fn()
    draw.getSnapshot.mockReturnValue([
      { id: 'p', geometry: { type: 'Point', coordinates: [1, 1] } },
    ])
    startRectangleDrawing(fakeMap().typed, onFinish)

    handlers.get('finish')?.('p')
    handlers.get('finish')?.('missing')

    expect(onFinish).not.toHaveBeenCalled()
  })

  it('stops the library when drawing is stopped', () => {
    const stop = startRectangleDrawing(fakeMap().typed, vi.fn())

    stop()

    expect(draw.stop).toHaveBeenCalledTimes(1)
  })

  it('gives the map its panning back, because stopping in the middle of a drag leaves it off', () => {
    const { map, typed } = fakeMap({ dragPan: true, dragRotate: true })
    const stop = startRectangleDrawing(typed, vi.fn())

    stop()

    expect(map.dragPan.enable).toHaveBeenCalledTimes(1)
    expect(map.dragRotate.enable).toHaveBeenCalledTimes(1)
  })

  it('does not switch on panning or rotating that the app had switched off itself', () => {
    const { map, typed } = fakeMap({ dragPan: false, dragRotate: false })

    startRectangleDrawing(typed, vi.fn())()

    expect(map.dragPan.enable).not.toHaveBeenCalled()
    expect(map.dragRotate.enable).not.toHaveBeenCalled()
  })

  it('waits for the map style instead of failing when the style is not loaded yet', () => {
    const { map, typed } = fakeMap({ styleLoaded: false })

    startRectangleDrawing(typed, vi.fn())

    expect(TerraDraw).not.toHaveBeenCalled()
    expect(map.once).toHaveBeenCalledWith('load', expect.any(Function))
    const begin = map.once.mock.calls[0]?.[1] as () => void
    begin()
    expect(TerraDraw).toHaveBeenCalledTimes(1)
    expect(draw.start).toHaveBeenCalled()
  })

  it('does not start drawing if it is stopped before the style has loaded', () => {
    const { map, typed } = fakeMap({ styleLoaded: false })

    const stop = startRectangleDrawing(typed, vi.fn())
    stop()

    expect(map.off).toHaveBeenCalledWith('load', map.once.mock.calls[0]?.[1])
    expect(TerraDraw).not.toHaveBeenCalled()
    expect(draw.stop).not.toHaveBeenCalled()
  })
})
