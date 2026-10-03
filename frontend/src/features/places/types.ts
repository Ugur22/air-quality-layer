import type { Bbox } from '@/features/regions/types'

/** One result of GET /api/v1/places (docs/api-contracts.md section 6). All text is plain text. */
export interface Place {
  id: string
  name: string
  /** The containing city, state and country; empty when unknown. */
  detail: string
  /** Photon's place type; unknown kinds are shown as they are. */
  kind: string
  /** [longitude, latitude] */
  point: [number, number]
  /** A box that is already a valid region, or null when the place is larger than 2 degrees. */
  bbox: Bbox | null
}
