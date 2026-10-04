import { describe, expect, it } from 'vitest'
import { pollutantLabel } from './pollutants'

describe('pollutantLabel', () => {
  it('names a known pollutant and keeps its key visible', () => {
    expect(pollutantLabel('bcwb')).toBe('Black carbon (wood burning) (bcwb)')
    expect(pollutantLabel('pm25')).toBe('PM2.5 (pm25)')
  })

  it('shows an unknown key as it is', () => {
    expect(pollutantLabel('xyz')).toBe('xyz')
  })

  it('does not name inherited object properties', () => {
    expect(pollutantLabel('constructor')).toBe('constructor')
    expect(pollutantLabel('toString')).toBe('toString')
  })
})
