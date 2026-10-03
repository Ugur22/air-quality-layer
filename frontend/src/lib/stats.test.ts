import { describe, expect, it } from 'vitest'
import { median, niceMax, ordinal, rankFromHighest } from './stats'

describe('median', () => {
  it('takes the middle of an odd count', () => {
    expect(median([9, 1, 5])).toBe(5)
  })
  it('averages the two middle values of an even count', () => {
    expect(median([1, 2, 3, 10])).toBe(2.5)
  })
  it('has none for no values, and does not reorder its input', () => {
    const input = [3, 1, 2]
    expect(median([])).toBeNull()
    median(input)
    expect(input).toEqual([3, 1, 2])
  })
})

describe('rankFromHighest', () => {
  it('is 1 for the highest and counts from there', () => {
    expect(rankFromHighest([5, 9, 7], 9)).toBe(1)
    expect(rankFromHighest([5, 9, 7], 5)).toBe(3)
  })
  it('gives equal values the same rank', () => {
    expect(rankFromHighest([9, 7, 7, 1], 7)).toBe(2)
  })
})

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [101, '101st'],
    [111, '111th'],
  ])('writes %i as %s', (n, text) => {
    expect(ordinal(n)).toBe(text)
  })
})

describe('niceMax', () => {
  it.each([
    [7.6, 10],
    [36.4, 40],
    [316, 400],
    [0.42, 0.5],
    [10, 10],
  ])('rounds %f up to %f', (value, expected) => {
    expect(niceMax(value)).toBeCloseTo(expected)
  })
  it('falls back to 1 for zero, negative or unusable values', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(-5)).toBe(1)
    expect(niceMax(Number.NaN)).toBe(1)
  })
})
