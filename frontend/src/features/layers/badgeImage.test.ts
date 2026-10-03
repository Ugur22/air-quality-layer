import { describe, expect, it } from 'vitest'
import { badgePixels } from './badgeImage'

describe('badgePixels', () => {
  const { width, height, data } = badgePixels()
  const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3] ?? 0

  it('is solid in the middle and clear in the corners, with the edge at 0.75 as MapLibre expects', () => {
    expect(alpha(width / 2, height / 2)).toBe(255)
    expect(alpha(0, 0)).toBe(0)
    // Distance 0 is the edge of the pill, at pixel 8 of 40: alpha 0.75 * 255, half a pixel in.
    expect(alpha(8, height / 2)).toBeGreaterThan(195)
    expect(alpha(8, height / 2)).toBeLessThan(215)
    expect(alpha(7, height / 2)).toBeLessThan(180)
  })

  it('is symmetric so it stretches evenly around the text', () => {
    expect(alpha(10, 20)).toBe(alpha(width - 1 - 10, 20))
    expect(alpha(20, 10)).toBe(alpha(20, height - 1 - 10))
  })
})
