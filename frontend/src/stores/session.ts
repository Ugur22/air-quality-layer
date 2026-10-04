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
  /** Show the whole-country layer instead of the region being worked on (ADR 0018). */
  nationalView: boolean
  setNationalView: (on: boolean) => void
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
  /**
   * The name the app, not the user, put in the form (a chosen place, or a drawn area). A name
   * that is empty or equal to this one may be replaced by the next place or drawn area; anything
   * else was typed by the user and is kept.
   */
  autoName: string | null
  setAreaName: (name: string) => void
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
  nationalView: false,
  setNationalView: (nationalView) => {
    // A selection or a pollutant filter from the other layer means nothing on this one.
    set({ nationalView, selectedStationId: null, filterValue: '', colourProperty: null })
  },
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
  autoName: null,
  setAreaName: (name) => {
    set((state) => ({ draft: { ...state.draft, name }, autoName: name }))
  },
  customAreaOpen: false,
  setCustomAreaOpen: (customAreaOpen) => {
    set({ customAreaOpen })
  },
  setDraftField: (field, value) => {
    // Typing a name makes it the user's, even if it is the same text as the app's.
    set((state) => ({
      draft: { ...state.draft, [field]: value },
      autoName: field === 'name' ? null : state.autoName,
    }))
  },
  setDraft: (values) => {
    set((state) => ({
      draft: { ...state.draft, ...values },
      autoName: values.name === undefined ? state.autoName : null,
    }))
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
      nationalView: false,
      syncJobId: null,
      colourProperty: null,
      selectedStationId: null,
      filterValue: '',
    })
  },
}))
