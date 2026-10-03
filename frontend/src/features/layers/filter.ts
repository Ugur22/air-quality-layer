/** The comparators of docs/api-contracts.md section 4, with words for the person choosing one. */
export const COMPARATORS = [
  { value: '=', label: 'equal to' },
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'at least' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'at most' },
] as const

export type Comparator = (typeof COMPARATORS)[number]['value']

export interface LayerFilter {
  property: string
  comparator: Comparator
  /** Kept as the typed text (normalised), so "10.50" is sent as written. */
  value: string
}

export type ParsedFilterValue =
  { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; value: string }

// Same grammar as the server: ASCII digits, optional minus, optional decimals, finite.
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/

export function parseFilterValue(raw: string): ParsedFilterValue {
  const text = raw.trim()
  if (text === '') return { kind: 'none' }
  // A single decimal comma is accepted, as in the region form.
  const normalised = /^-?[0-9]+,[0-9]+$/.test(text) ? text.replace(',', '.') : text
  if (!NUMBER.test(normalised) || !Number.isFinite(Number(normalised))) return { kind: 'invalid' }
  return { kind: 'ok', value: normalised }
}
