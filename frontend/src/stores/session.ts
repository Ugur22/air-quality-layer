import { create } from 'zustand'
import type { Comparator } from '@/features/layers/filter'
import type { Bbox, Region } from '@/features/regions/types'
import { EMPTY_DRAFT, type RegionFormValues } from '@/features/regions/validation'

/**
 * UI state only: what the user is working on. Server data (projects, sync jobs, layers) lives in
 * TanStack Query. A module-level singleton, so tests must reset it (docs/quality.md).
 */
interface SessionState {
  region: Region | null
  syncJobId: string | null
  /** The pollutant the map colours by; null means "the layer's default". */
  colourProperty: string | null
  selectedStationId: string | null
  /** The layer filter as typed: "<pollutant> <comparator> <value>". */
  filterComparator: Comparator
  filterValue: string
  setFilterComparator: (comparator: Comparator) => void
  setFilterValue: (value: string) => void
  /** The region form's values. They live here so the map can preview the box and, later, draw it. */
  draft: RegionFormValues
  setDraftField: (field: keyof RegionFormValues, value: string) => void
  setDraft: (values: Partial<RegionFormValues>) => void
  /** A request to move the map to a box (for example a chosen place); each one has a new id. */
  viewRequest: { bbox: Bbox; id: number } | null
  focusBox: (bbox: Bbox) => void
  /** The coordinate fields live under a "Custom area" disclosure; true shows them. */
  customAreaOpen: boolean
  setCustomAreaOpen: (open: boolean) => void
  setRegion: (region: Region) => void
  setSyncJobId: (id: string) => void
  setColourProperty: (property: string) => void
  selectStation: (id: string | null) => void
  reset: () => void
}

export const useSession = create<SessionState>((set) => ({
  region: null,
  syncJobId: null,
  colourProperty: null,
  selectedStationId: null,
  filterComparator: '>',
  filterValue: '',
  setFilterComparator: (filterComparator) => {
    set({ filterComparator })
  },
  setFilterValue: (filterValue) => {
    set({ filterValue })
  },
  draft: EMPTY_DRAFT,
  customAreaOpen: false,
  setCustomAreaOpen: (customAreaOpen) => {
    set({ customAreaOpen })
  },
  setDraftField: (field, value) => {
    set((state) => ({ draft: { ...state.draft, [field]: value } }))
  },
  setDraft: (values) => {
    set((state) => ({ draft: { ...state.draft, ...values } }))
  },
  viewRequest: null,
  focusBox: (bbox) => {
    set((state) => ({ viewRequest: { bbox, id: (state.viewRequest?.id ?? 0) + 1 } }))
  },
  setRegion: (region) => {
    set({ region })
  },
  setSyncJobId: (syncJobId) => {
    set({ syncJobId })
  },
  setColourProperty: (colourProperty) => {
    set({ colourProperty })
  },
  selectStation: (selectedStationId) => {
    set({ selectedStationId })
  },
  reset: () => {
    set({
      region: null,
      syncJobId: null,
      colourProperty: null,
      selectedStationId: null,
      filterValue: '',
    })
  },
}))
