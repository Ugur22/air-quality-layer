import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '@/stores/session'
import { apiError, jsonResponse, mockApi, type RecordedCall } from '@/test/mockApi'
import { renderWithClient } from '@/test/renderWithClient'
import { PlaceSearchBox } from './PlaceSearchBox'
import type { Place } from './types'

vi.mock('@/features/places/searchTiming', () => ({ PLACE_SEARCH_DEBOUNCE_MS: 50 }))

const AMSTERDAM: Place = {
  id: 'R271110',
  name: 'Amsterdam',
  detail: 'Noord-Holland, Nederland',
  kind: 'city',
  point: [4.8979755, 52.3745403],
  bbox: [4.7288, 52.2782, 5.0792, 52.4311],
}
const US_AMSTERDAM: Place = {
  id: 'R3143401',
  name: 'Amsterdam',
  detail: 'Montgomery, New York, United States',
  kind: 'city',
  point: [-74.19, 42.93],
  bbox: [-74.2421, 42.8925, -74.1421, 42.9925],
}
const NETHERLANDS: Place = {
  id: 'R2323309',
  name: 'Nederland',
  detail: '',
  kind: 'country',
  point: [5.3, 52.1],
  bbox: null,
}

const ROUTE = 'GET /api/v1/places'
const places =
  (...list: Place[]) =>
  () =>
    jsonResponse(200, { places: list })

function box() {
  return renderWithClient(<PlaceSearchBox />)
}

const input = () => screen.getByRole('combobox', { name: /search for a place/i })

beforeEach(() => {
  useSession.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlaceSearchBox', () => {
  it('sends nothing until at least 3 characters are typed, and says so', async () => {
    const { calls } = mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()

    await user.type(input(), 'am')

    expect(screen.getByText(/at least 3 characters/i)).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(calls).toHaveLength(0)
  })

  it('shows what was found, with the detail line that tells same-named places apart', async () => {
    const { calls } = mockApi({ [ROUTE]: places(AMSTERDAM, US_AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()

    await user.type(input(), 'amsterdam')

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('Amsterdam')
    expect(options[0]).toHaveTextContent('Noord-Holland, Nederland')
    expect(options[1]).toHaveTextContent('Montgomery, New York, United States')
    expect(new URLSearchParams(calls[0]?.search).get('q')).toBe('amsterdam')
  })

  it('sends one request after typing pauses, not one per keystroke', async () => {
    const { calls } = mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()

    await user.type(input(), 'amsterdam')
    await screen.findAllByRole('option')

    expect(new Set(calls.map((c) => new URLSearchParams(c.search).get('q')))).toEqual(
      new Set(['amsterdam']),
    )
  })

  it('fills the name and the four box fields when a place is chosen, and closes the list', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')

    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))

    const { draft } = useSession.getState()
    expect(draft).toMatchObject({
      name: 'Amsterdam',
      minLon: '4.7288',
      minLat: '52.2782',
      maxLon: '5.0792',
      maxLat: '52.4311',
    })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(input()).toHaveValue('Amsterdam')
  })

  it('does not search again for the name it just put into the box', async () => {
    const { calls } = mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    // Typed "amst" but chosen "Amsterdam": the name is a different text, so a search for it would
    // be a new request (not a cache hit).
    await user.type(input(), 'amst')
    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))
    const afterChoosing = calls.length

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(input()).toHaveValue('Amsterdam')
    expect(calls).toHaveLength(afterChoosing)
  })

  it('asks the map to move to the chosen place', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')

    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))

    expect(useSession.getState().viewRequest?.bbox).toEqual([4.7288, 52.2782, 5.0792, 52.4311])
  })

  it('works from the keyboard: arrow keys and Enter', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM, US_AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')
    await screen.findAllByRole('option')

    await user.keyboard('{ArrowDown}{Enter}')

    expect(useSession.getState().draft.minLon).toBe('-74.2421')
  })

  it('shows a place that is too large, but cannot be chosen', async () => {
    mockApi({ [ROUTE]: places(NETHERLANDS) })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'netherlands')

    useSession.getState().setDraftField('name', 'Typed name')
    const option = await screen.findByRole('option', { name: /nederland/i })

    expect(option).toHaveAttribute('aria-disabled', 'true')
    expect(option).toHaveTextContent(/too large/i)
    await user.click(option)
    expect(useSession.getState().draft.name).toBe('Typed name')
    expect(useSession.getState().viewRequest).toBeNull()
  })

  it('replaces the name an earlier drawn area was given', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    useSession.getState().setDraftField('name', 'Custom area')
    box()

    await user.type(input(), 'amsterdam')
    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))

    expect(useSession.getState().draft.name).toBe('Amsterdam')
  })

  it('says so when nothing matches', async () => {
    mockApi({ [ROUTE]: places() })
    const user = userEvent.setup({ delay: null })
    box()

    await user.type(input(), 'qqqqqq')

    expect(await screen.findByText('No places found.')).toBeInTheDocument()
  })

  it('explains an unavailable search and points to the other ways of defining a region', async () => {
    mockApi({
      [ROUTE]: () =>
        apiError(
          503,
          'service_unavailable',
          'Place search is unavailable right now. Type the coordinates or draw the box instead.',
        ),
    })
    const user = userEvent.setup({ delay: null })
    box()

    await user.type(input(), 'amsterdam')

    expect(await screen.findByRole('alert')).toHaveTextContent(/coordinates or draw the box/i)
  })

  it('asks the user to wait when searches are limited', async () => {
    mockApi({ [ROUTE]: () => apiError(429, 'rate_limited', 'Too many searches. Wait a moment.') })
    const user = userEvent.setup({ delay: null })
    box()

    await user.type(input(), 'amsterdam')

    expect(await screen.findByRole('alert')).toHaveTextContent(/wait a moment/i)
  })

  it('shows a place name as plain text even when it looks like HTML', async () => {
    const hostile: Place = {
      ...AMSTERDAM,
      name: '<img src=x onerror="alert(1)">',
      detail: '<b>bold</b>',
    }
    mockApi({ [ROUTE]: places(hostile) })
    const user = userEvent.setup({ delay: null })
    const { container } = box()
    await user.type(input(), 'hostile')

    const option = await screen.findByRole('option')

    expect(option).toHaveTextContent('<img src=x onerror="alert(1)">')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('credits the data source with links', () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    box()

    const credit = screen.getByText(/search by/i)

    expect(within(credit).getByRole('link', { name: /photon/i })).toHaveAttribute(
      'href',
      expect.stringContaining('photon.komoot.io'),
    )
    expect(within(credit).getByRole('link', { name: /openstreetmap/i })).toHaveAttribute(
      'href',
      expect.stringContaining('openstreetmap.org'),
    )
  })

  it('shows the answer to what was typed last when an older request finishes later', async () => {
    let finishFirst: (() => void) | undefined
    mockApi({
      [ROUTE]: async (call: RecordedCall) => {
        if (new URLSearchParams(call.search).get('q') === 'amst') {
          await new Promise<void>((resolve) => {
            finishFirst = resolve
          })
          return jsonResponse(200, { places: [US_AMSTERDAM] })
        }
        return jsonResponse(200, { places: [AMSTERDAM] })
      },
    })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amst')
    await waitFor(() => {
      expect(finishFirst).toBeDefined()
    })

    await user.type(input(), 'erdam')
    await screen.findByRole('option', { name: /noord-holland/i })
    finishFirst?.()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Noord-Holland')
  })

  it('does not ask again for a query it already has', async () => {
    const { calls } = mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')
    await screen.findAllByRole('option')

    await user.clear(input())
    await user.type(input(), 'amsterdam')
    await screen.findAllByRole('option')

    expect(calls).toHaveLength(1)
  })

  it('closes the list with Escape', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')
    await screen.findAllByRole('option')

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('says when the server cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    const user = userEvent.setup({ delay: null })
    box()

    await user.type(input(), 'amsterdam')

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i)
  })

  it('hides the list of an earlier search as soon as the text changes, instead of leaving it pickable', async () => {
    mockApi({
      [ROUTE]: async (call: RecordedCall) => {
        if (new URLSearchParams(call.search).get('q') === 'amsterdam') {
          return jsonResponse(200, { places: [AMSTERDAM] })
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
        return jsonResponse(200, { places: [US_AMSTERDAM] })
      },
    })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')
    await screen.findByRole('option', { name: /noord-holland/i })

    await user.type(input(), 'x')

    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Searching…')
    expect(await screen.findByRole('option', { name: /new york/i })).toBeInTheDocument()
  })

  it('keeps one live region that says what is happening, linked to the input', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM, US_AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    const status = screen.getByRole('status')
    expect(input()).toHaveAttribute('aria-describedby', status.id)
    expect(status).toHaveTextContent('')

    await user.type(input(), 'am')
    expect(status).toHaveTextContent(/at least 3 characters/i)

    await user.type(input(), 'sterdam')
    await screen.findAllByRole('option')
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('2 places found')
  })

  it('says "1 place found" for a single result', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()

    await user.type(input(), 'amsterdam')

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('1 place found')
    })
  })

  it('keeps a name the user typed and says so, while still setting the box', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    useSession.getState().setDraft({ name: 'My own name' })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')

    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))

    const { draft } = useSession.getState()
    expect(draft.name).toBe('My own name')
    expect(draft.minLon).toBe('4.7288')
    expect(screen.getByRole('status')).toHaveTextContent(/name was kept/i)
  })

  it('replaces the example name, an empty name and the name of a previously chosen place', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()

    // 1. the example name that the form opens with
    await user.type(input(), 'amst')
    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))
    expect(useSession.getState().draft.name).toBe('Amsterdam')

    // 2. the name of the place chosen a moment ago
    useSession.getState().setDraft({ name: 'Amsterdam' })
    await user.clear(input())
    await user.type(input(), 'amste')
    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))
    expect(useSession.getState().draft.name).toBe('Amsterdam')

    // 3. an empty name
    useSession.getState().setDraft({ name: '   ' })
    await user.clear(input())
    await user.type(input(), 'amster')
    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))
    expect(useSession.getState().draft.name).toBe('Amsterdam')
    expect(screen.getByRole('status')).toHaveTextContent('Region set to Amsterdam')
  })

  it('puts focus back in the search box after choosing, so the keyboard user is not lost', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')

    await user.click(await screen.findByRole('option', { name: /amsterdam/i }))

    expect(input()).toHaveFocus()
  })

  it('reopens the list with a click or the down arrow when the box already holds a search', async () => {
    mockApi({ [ROUTE]: places(AMSTERDAM) })
    const user = userEvent.setup({ delay: null })
    box()
    await user.type(input(), 'amsterdam')
    await screen.findAllByRole('option')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('option')).not.toBeInTheDocument()

    await user.keyboard('{ArrowDown}')
    expect(await screen.findAllByRole('option')).toHaveLength(1)

    await user.keyboard('{Escape}')
    await user.click(input())
    expect(await screen.findAllByRole('option')).toHaveLength(1)
  })

  it('stops the text at the length the server accepts', () => {
    mockApi({})
    box()

    expect(input()).toHaveAttribute('maxlength', '100')
  })
})
