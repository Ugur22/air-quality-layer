import { describe, expect, it } from 'vitest'
import { formatAge, isStale } from './freshness'

const now = new Date('2026-10-03T10:00:00Z')

describe('isStale', () => {
  it.each([
    ['a minute old', '2026-10-03T09:59:00Z', false],
    ['23 hours 59 minutes old', '2026-10-02T10:01:00Z', false],
    ['exactly 24 hours old', '2026-10-02T10:00:00Z', true],
    ['older than 24 hours', '2026-10-01T10:00:00Z', true],
    ['from February', '2026-02-18T14:00:00Z', true],
  ])('treats a reading that is %s correctly', (_label, observedAt, expected) => {
    expect(isStale(observedAt, now)).toBe(expected)
  })
})

describe('formatAge', () => {
  it.each([
    ['2026-10-03T09:30:00Z', 'under an hour ago'],
    ['2026-10-03T08:00:00Z', '2 h ago'],
    ['2026-10-02T09:00:00Z', '1 day ago'],
    ['2026-09-30T10:00:00Z', '3 days ago'],
    ['2026-02-18T14:00:00Z', '7 months ago'],
    ['2026-10-03T11:00:00Z', 'under an hour ago'],
  ])('describes %s as %s', (observedAt, expected) => {
    expect(formatAge(observedAt, now)).toBe(expected)
  })
})

describe('an unreadable timestamp', () => {
  it('is not claimed to be stale', () => {
    expect(isStale('not a date', now)).toBe(false)
  })

  it('is described as unknown instead of NaN', () => {
    expect(formatAge('not a date', now)).toBe('time unknown')
  })
})
