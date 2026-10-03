import { describe, expect, it } from 'vitest'
import { rectangleToBbox } from './regionDrawing'

describe('rectangleToBbox', () => {
  it('returns [west, south, east, north] of a closed rectangle ring', () => {
    const ring = [
      [4.85, 52.35],
      [4.95, 52.35],
      [4.95, 52.4],
      [4.85, 52.4],
      [4.85, 52.35],
    ]

    expect(rectangleToBbox(ring)).toEqual([4.85, 52.35, 4.95, 52.4])
  })

  it('does not care which corner the user started from', () => {
    const ring = [
      [4.95, 52.4],
      [4.85, 52.4],
      [4.85, 52.35],
      [4.95, 52.35],
      [4.95, 52.4],
    ]

    expect(rectangleToBbox(ring)).toEqual([4.85, 52.35, 4.95, 52.4])
  })

  it('rounds to 4 decimals, the precision OpenAQ and the form accept', () => {
    const ring = [
      [4.851234567, 52.351234567],
      [4.951234567, 52.351234567],
      [4.951234567, 52.401234567],
      [4.851234567, 52.401234567],
      [4.851234567, 52.351234567],
    ]

    expect(rectangleToBbox(ring)).toEqual([4.8512, 52.3512, 4.9512, 52.4012])
  })

  it('brings longitudes from a repeated world copy back into -180 to 180', () => {
    const ring = [
      [365.1, 10],
      [365.3, 10],
      [365.3, 10.2],
      [365.1, 10.2],
      [365.1, 10],
    ]

    expect(rectangleToBbox(ring)).toEqual([5.1, 10, 5.3, 10.2])
  })

  it('keeps a small box small (no rounding it down to nothing)', () => {
    const ring = [
      [4.9, 52.37],
      [4.9004, 52.37],
      [4.9004, 52.3704],
      [4.9, 52.3704],
      [4.9, 52.37],
    ]

    expect(rectangleToBbox(ring)).toEqual([4.9, 52.37, 4.9004, 52.3704])
  })
})
