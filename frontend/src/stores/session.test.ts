import { describe, expect, it } from 'vitest'
import { useSession } from './session'

describe('session store: place search support', () => {
  it('sets several draft fields at once and keeps the rest', () => {
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
