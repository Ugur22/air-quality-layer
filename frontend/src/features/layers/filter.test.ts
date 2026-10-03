import { describe, expect, it } from 'vitest'
import { COMPARATORS, parseFilterValue } from './filter'

describe('parseFilterValue', () => {
  it('treats an empty box as no filter, not as an error', () => {
    expect(parseFilterValue('')).toEqual({ kind: 'none' })
    expect(parseFilterValue('   ')).toEqual({ kind: 'none' })
  })

  it.each([
    ['10', '10'],
    ['-3.5', '-3.5'],
    ['0', '0'],
    ['10.50', '10.50'],
    [' 7 ', '7'],
    ['4,5', '4.5'],
  ])('accepts %s as %s', (raw, value) => {
    expect(parseFilterValue(raw)).toEqual({ kind: 'ok', value })
  })

  it.each(['abc', '1e3', '+5', '.5', '5.', '1,2,3', '12 3', '--1', '١٢', '9'.repeat(400)])(
    'rejects %s, as the server would',
    (raw) => {
      expect(parseFilterValue(raw)).toEqual({ kind: 'invalid' })
    },
  )
})

describe('COMPARATORS', () => {
  it('offers exactly the comparators of the contract, with words for each', () => {
    expect(COMPARATORS.map((c) => c.value)).toEqual(['=', '>', '>=', '<', '<='])
    expect(COMPARATORS.map((c) => c.label)).toEqual([
      'equal to',
      'greater than',
      'at least',
      'less than',
      'at most',
    ])
  })
})
