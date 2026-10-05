import { beforeEach, describe, expect, it } from 'vitest'
import { amsterdamDraft } from '@/test/fixtures'
import { useSession } from './session'

describe('session store: who named the region', () => {
  it('remembers a name the app set, so the next place or drawn area may replace it', () => {
    useSession.getState().setAreaName('Utrecht')

    expect(useSession.getState().draft.name).toBe('Utrecht')
    expect(useSession.getState().autoName).toBe('Utrecht')
  })

  it("treats a typed name as the user's, even when it reads the same", () => {
    useSession.getState().setAreaName('Utrecht')
    useSession.getState().setDraftField('name', 'Utrecht')

    expect(useSession.getState().autoName).toBeNull()
  })

  it("treats a name given through setDraft as the user's, and keeps the mark when the name is not touched", () => {
    useSession.getState().setAreaName('Utrecht')
    useSession.getState().setDraft({ minLon: '1' })
    expect(useSession.getState().autoName).toBe('Utrecht')

    useSession.getState().setDraft({ name: 'Mine' })
    expect(useSession.getState().autoName).toBeNull()
  })
})

describe('session store: place search support', () => {
  it('sets several draft fields at once and keeps the rest', () => {
    useSession.setState({ draft: amsterdamDraft })
    useSession.getState().setDraft({ name: 'Park', minLon: '1' })

    const { draft } = useSession.getState()
    expect(draft).toMatchObject({ name: 'Park', minLon: '1', minLat: '52.35', maxLon: '4.95' })
  })

  it('makes every request to move the map a new one, even for the same box', () => {
    const { focusBox } = useSession.getState()

    focusBox([1, 2, 3, 4])
    const first = useSession.getState().viewRequest
    focusBox([1, 2, 3, 4])
    const second = useSession.getState().viewRequest

    expect(first?.bbox).toEqual([1, 2, 3, 4])
    expect(second?.id).toBeGreaterThan(first?.id ?? 0)
  })

  it('forgets the draft only when asked, not when a new sync starts', () => {
    useSession.getState().setDraft({ name: 'Keep me' })

    useSession.getState().reset()

    expect(useSession.getState().draft.name).toBe('Keep me')
  })
})

describe('session store: comparing countries', () => {
  beforeEach(() => {
    useSession.setState({ countries: ['NL'] })
  })

  it('adds a second country and removes one again', () => {
    useSession.getState().toggleCountry('DE')
    expect(useSession.getState().countries).toEqual(['NL', 'DE'])

    useSession.getState().toggleCountry('NL')
    expect(useSession.getState().countries).toEqual(['DE'])
  })

  it('refuses a third country and removing the last one', () => {
    useSession.getState().toggleCountry('DE')
    useSession.getState().toggleCountry('FR')
    expect(useSession.getState().countries).toEqual(['NL', 'DE'])

    useSession.getState().toggleCountry('DE')
    useSession.getState().toggleCountry('NL')
    expect(useSession.getState().countries).toEqual(['NL'])
  })

  it('drops a selection and filter that belonged to the earlier countries', () => {
    useSession.setState({ selectedStationId: 's', filterValue: '5', colourProperty: 'no2' })

    useSession.getState().toggleCountry('DE')

    expect(useSession.getState()).toMatchObject({
      selectedStationId: null,
      filterValue: '',
      colourProperty: null,
    })
  })
})
