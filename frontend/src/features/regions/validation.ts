import type { Bbox } from './types'

export interface RegionFormValues {
  name: string
  minLon: string
  minLat: string
  maxLon: string
  maxLat: string
}

export type FormErrors = Partial<Record<keyof RegionFormValues | 'bbox', string>>

export type ValidationResult =
  { ok: true; value: { name: string; bbox: Bbox } } | { ok: false; errors: FormErrors }

// Mirrors the server's rules (docs/api-contracts.md section 1) so most mistakes are caught before
// a request is made. The server stays the authority and re-checks everything.
const MAX_NAME_LENGTH = 200
const MAX_SPAN_DEGREES = 2
// 145.7473 - 143.7473 is 2.0000000000000284 in floating point; a box exactly 2 degrees wide is valid.
const SPAN_TOLERANCE = 1e-9
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/

function parseNumber(raw: string): number | null {
  const text = raw.trim()
  // A single decimal comma is accepted because that is how it is typed in many locales.
  const normalised = /^-?[0-9]+,[0-9]+$/.test(text) ? text.replace(',', '.') : text
  return NUMBER.test(normalised) ? Number(normalised) : null
}

type BoxValues = Pick<RegionFormValues, 'minLon' | 'minLat' | 'maxLon' | 'maxLat'>
type BoxErrors = Omit<FormErrors, 'name'>

/** The four numbers and the box they make: everything except the name. */
function validateBox(
  values: BoxValues,
): { ok: true; bbox: Bbox } | { ok: false; errors: BoxErrors } {
  const errors: BoxErrors = {}

  const lon = (field: 'minLon' | 'maxLon'): number | null => {
    const n = parseNumber(values[field])
    if (n === null) errors[field] = 'Enter a number such as 4.85.'
    else if (n < -180 || n > 180) errors[field] = 'Longitude must be between -180 and 180.'
    return n !== null && errors[field] === undefined ? n : null
  }
  const lat = (field: 'minLat' | 'maxLat'): number | null => {
    const n = parseNumber(values[field])
    if (n === null) errors[field] = 'Enter a number such as 52.35.'
    else if (n < -90 || n > 90) errors[field] = 'Latitude must be between -90 and 90.'
    return n !== null && errors[field] === undefined ? n : null
  }

  const minLon = lon('minLon')
  const minLat = lat('minLat')
  const maxLon = lon('maxLon')
  const maxLat = lat('maxLat')

  if (minLon !== null && maxLon !== null && minLat !== null && maxLat !== null) {
    if (minLon >= maxLon) errors.bbox = 'West must be smaller than east.'
    else if (minLat >= maxLat) errors.bbox = 'South must be smaller than north.'
    else if (
      maxLon - minLon > MAX_SPAN_DEGREES + SPAN_TOLERANCE ||
      maxLat - minLat > MAX_SPAN_DEGREES + SPAN_TOLERANCE
    ) {
      errors.bbox = 'The region may be at most 2 degrees wide and 2 degrees high.'
    }
  }

  if (
    Object.keys(errors).length > 0 ||
    minLon === null ||
    minLat === null ||
    maxLon === null ||
    maxLat === null
  ) {
    return { ok: false, errors }
  }
  return { ok: true, bbox: [minLon, minLat, maxLon, maxLat] }
}

export function validateRegionForm(values: RegionFormValues): ValidationResult {
  const errors: FormErrors = {}

  const name = values.name.trim()
  if (name === '') errors.name = 'Enter a name for the region.'
  else if (name.length > MAX_NAME_LENGTH) errors.name = 'Use at most 200 characters.'

  const box = validateBox(values)
  if (!box.ok) Object.assign(errors, box.errors)

  if (Object.keys(errors).length > 0 || !box.ok) return { ok: false, errors }
  return { ok: true, value: { name, bbox: box.bbox } }
}

/** An example region (central Amsterdam) so the form, and the map behind it, open in a working state. */
export const EXAMPLE_REGION: RegionFormValues = {
  name: 'Amsterdam centre',
  minLon: '4.85',
  minLat: '52.35',
  maxLon: '4.95',
  maxLat: '52.40',
}

/** The box typed so far, if it is already a valid one; used to preview it on the map. */
export function draftBbox(values: RegionFormValues): Bbox | null {
  const box = validateBox(values)
  return box.ok ? box.bbox : null
}

/** Why the typed box cannot be used, in the form's own words, or null when it can. */
export function boxProblem(values: RegionFormValues): string | null {
  const box = validateBox(values)
  if (box.ok) return null
  const { bbox, minLon, minLat, maxLon, maxLat } = box.errors
  return bbox ?? minLon ?? minLat ?? maxLon ?? maxLat ?? null
}
