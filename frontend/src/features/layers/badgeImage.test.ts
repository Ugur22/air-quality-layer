import { describe, expect, it } from 'vitest'
import { badgePixels, staleBadgePixels } from './badgeImage'

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

describe('staleBadgePixels', () => {
  const { width, height, data } = staleBadgePixels('#fd8d3c')
  const rgba = (x: number, y: number) =>
    Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4))
  const mid = height / 2

  it('is opaque white inside, so the dot under the badge cannot show through', () => {
    expect(rgba(width / 2, mid)).toEqual([255, 255, 255, 255])
  })

  it('has an ink edge outside a ring in the class colour, then white', () => {
    // Pixel 8 is the pill's edge (distance 0). Walking in: ink, the ring, then white.
    expect(rgba(7, mid)).toEqual([0x12, 0x20, 0x1f, 255])
    expect(rgba(9, mid)).toEqual([0xfd, 0x8d, 0x3c, 255])
    expect(rgba(13, mid)).toEqual([255, 255, 255, 255])
  })

  it('is clear in the corners, outside the ink edge', () => {
    expect(rgba(0, 0)[3]).toBe(0)
  })

  it('has the same outline as the current badge and its halo', () => {
    // A current badge draws its halo 1.5 texels outside the edge at pixel 8, so pixel 6 is the
    // outermost covered one; the hollow badge must not spill past it.
    expect(rgba(5, mid)[3]).toBe(0)
    expect(rgba(6, mid)[3]).toBeGreaterThan(100)
  })
})
