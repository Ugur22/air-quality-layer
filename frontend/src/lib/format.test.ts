import { describe, expect, it } from 'vitest'
import { formatValue } from './format'

describe('formatValue', () => {
  it.each([
    [36.44749984741211, '36.45'],
    [7.6, '7.6'],
    [530, '530'],
    [0, '0'],
    [-0.4, '-0.4'],
    [2727.4833333333336, '2727.48'],
    [0.004, '0'],
  ])('shows %s as %s', (value, expected) => {
    expect(formatValue(value)).toBe(expected)
  })
})
