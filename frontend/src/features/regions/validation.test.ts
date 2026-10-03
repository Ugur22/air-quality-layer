import { describe, expect, it } from 'vitest'
import { boxProblem, draftBbox, validateRegionForm, type RegionFormValues } from './validation'

const valid: RegionFormValues = {
  name: 'Amsterdam centre',
  minLon: '4.85',
  minLat: '52.35',
  maxLon: '4.95',
  maxLat: '52.40',
}

describe('validateRegionForm', () => {
  it('accepts a valid region and returns numbers', () => {
    expect(validateRegionForm(valid)).toEqual({
      ok: true,
      value: { name: 'Amsterdam centre', bbox: [4.85, 52.35, 4.95, 52.4] },
    })
  })

  it('trims the name and the numbers', () => {
    const result = validateRegionForm({ ...valid, name: '  Centre ', minLon: ' 4.85 ' })

    expect(result).toMatchObject({ ok: true, value: { name: 'Centre' } })
  })

  it('accepts a decimal comma, as typed in Dutch locales', () => {
    const result = validateRegionForm({ ...valid, minLon: '4,85', maxLat: '52,40' })

    expect(result).toMatchObject({ ok: true, value: { bbox: [4.85, 52.35, 4.95, 52.4] } })
  })

  it.each<[string, Partial<RegionFormValues>, string, string]>([
    ['an empty name', { name: '' }, 'name', 'Enter a name'],
    ['a whitespace name', { name: '   ' }, 'name', 'Enter a name'],
    ['a name over 200 characters', { name: 'x'.repeat(201) }, 'name', 'at most 200'],
    ['an empty number', { minLon: '' }, 'minLon', 'Enter a number'],
    ['text instead of a number', { minLat: 'north' }, 'minLat', 'Enter a number'],
    ['an exponent', { maxLon: '1e1' }, 'maxLon', 'Enter a number'],
    ['two commas', { maxLat: '52,4,0' }, 'maxLat', 'Enter a number'],
    ['a longitude above 180', { maxLon: '181' }, 'maxLon', 'between -180 and 180'],
    ['a longitude below -180', { minLon: '-181' }, 'minLon', 'between -180 and 180'],
    ['a latitude above 90', { maxLat: '91' }, 'maxLat', 'between -90 and 90'],
    ['a latitude below -90', { minLat: '-91' }, 'minLat', 'between -90 and 90'],
  ])('rejects %s', (_label, change, field, message) => {
    const result = validateRegionForm({ ...valid, ...change })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[field as keyof typeof result.errors]).toContain(message)
  })

  it.each<[string, Partial<RegionFormValues>, string]>([
    ['west of east inverted', { minLon: '4.95', maxLon: '4.85' }, 'West must be smaller than east'],
    [
      'south of north inverted',
      { minLat: '52.40', maxLat: '52.35' },
      'South must be smaller than north',
    ],
    ['zero width', { maxLon: '4.85' }, 'West must be smaller than east'],
    ['zero height', { maxLat: '52.35' }, 'South must be smaller than north'],
    ['wider than 2 degrees', { minLon: '3', maxLon: '5.5' }, 'at most 2 degrees'],
    ['taller than 2 degrees', { minLat: '50', maxLat: '52.5' }, 'at most 2 degrees'],
  ])('rejects a box that is %s', (_label, change, message) => {
    const result = validateRegionForm({ ...valid, ...change })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.bbox).toContain(message)
  })

  it('accepts a box of exactly 2 degrees even when floating point makes it a hair wider', () => {
    const result = validateRegionForm({ ...valid, minLon: '143.7473', maxLon: '145.7473' })

    expect(result.ok).toBe(true)
  })

  it('accepts a box of exactly 2 degrees', () => {
    const result = validateRegionForm({ ...valid, minLon: '3', maxLon: '5' })

    expect(result.ok).toBe(true)
  })

  it('reports every field problem at once', () => {
    const result = validateRegionForm({ name: '', minLon: '', minLat: 'x', maxLon: '', maxLat: '' })

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(Object.keys(result.errors).sort()).toEqual([
        'maxLat',
        'maxLon',
        'minLat',
        'minLon',
        'name',
      ])
  })
})

describe('draftBbox', () => {
  it('returns the box when the four numbers are valid', () => {
    expect(draftBbox(valid)).toEqual([4.85, 52.35, 4.95, 52.4])
  })

  it('does not depend on the name, so a name rule can never hide the box', () => {
    expect(draftBbox({ ...valid, name: '' })).toEqual([4.85, 52.35, 4.95, 52.4])
    expect(draftBbox({ ...valid, name: 'x'.repeat(500) })).toEqual([4.85, 52.35, 4.95, 52.4])
  })

  it.each([
    ['a missing number', { minLon: '' }],
    ['an inverted box', { minLon: '5', maxLon: '4' }],
    ['a box over 2 degrees', { minLon: '1', maxLon: '5' }],
  ])('is null for %s', (_label, change) => {
    expect(draftBbox({ ...valid, ...change })).toBeNull()
  })
})

describe('boxProblem', () => {
  it('is null for a valid box', () => {
    expect(boxProblem(valid)).toBeNull()
  })

  it('says what is wrong with the box, in the same words as the form', () => {
    expect(boxProblem({ ...valid, minLon: '1', maxLon: '5' })).toMatch(/at most 2 degrees/)
    expect(boxProblem({ ...valid, minLon: '5', maxLon: '4' })).toBe(
      'West must be smaller than east.',
    )
    expect(boxProblem({ ...valid, minLat: 'north' })).toMatch(/enter a number/i)
  })
})
