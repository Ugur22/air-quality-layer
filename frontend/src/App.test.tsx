import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { layerServer } from '@/test/layerServer'
import { apiError, jsonResponse, mockApi } from '@/test/mockApi'
import { amsterdamDraft, layer, project, region, succeededJob, syncJob } from '@/test/fixtures'
import { renderApp } from '@/test/renderApp'
import { EMPTY_DRAFT } from '@/features/regions/validation'
import { useSession } from '@/stores/session'
import { startRectangleDrawing } from '@/features/layers/regionDrawing'
import type { SyncJob } from '@/features/syncs/types'

vi.mock('react-map-gl/maplibre', async () => await import('@/test/mockMapLibre'))
vi.mock('@/features/layers/regionDrawing', () => ({ startRectangleDrawing: vi.fn(() => vi.fn()) }))

// Poll fast so tests do not wait a second per status.
vi.mock('@/features/syncs/polling', () => ({ POLL_INTERVAL_MS: 5 }))
vi.mock('@/features/layers/filterTiming', () => ({ FILTER_DEBOUNCE_MS: 5 }))
vi.mock('@/features/places/searchTiming', () => ({ PLACE_SEARCH_DEBOUNCE_MS: 5 }))

const REGIONS = `POST /api/v1/projects/${project.id}/regions`

/** A sync job endpoint that answers with each status in turn, then keeps the last one. */
function syncSequence(...jobs: SyncJob[]) {
  let i = 0
  return () => jsonResponse(200, { sync_job: jobs[Math.min(i++, jobs.length - 1)] })
}

beforeEach(() => {
  useSession.getState().reset()
  // The app opens with no area; most tests start from a filled form with its coordinates shown.
  useSession.setState({ draft: amsterdamDraft, customAreaOpen: true })
  // Only Date is faked, so station freshness is stable while real timers keep polling working.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-03T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const baseRoutes = {
  'GET /api/v1/projects': () => jsonResponse(200, { projects: [project] }),
  [REGIONS]: () => jsonResponse(201, { region }),
  'POST /api/v1/regions/:id/syncs': () => jsonResponse(202, { sync_job: syncJob() }),
  'GET /api/v1/map-layers/:id': layerServer(layer),
}

describe('App', () => {
  it('shows the product name and loads the project before showing the form', async () => {
    mockApi({ ...baseRoutes })

    renderApp()

    expect(screen.getByRole('heading', { name: 'AirLayer' })).toBeInTheDocument()
    expect(screen.getByText(/loading your project/i)).toBeInTheDocument()
    expect(await screen.findByRole('form', { name: 'Region' })).toBeInTheDocument()
  })

  describe('before an area is chosen', () => {
    beforeEach(() => {
      useSession.setState({ draft: EMPTY_DRAFT, customAreaOpen: false })
    })

    it('opens with no box on the map, a prompt, and nothing to sync', async () => {
      mockApi({ ...baseRoutes })

      renderApp()

      expect(await screen.findByLabelText('Name')).toHaveValue('')
      const outline = JSON.parse(
        screen.getByTestId('source-region').getAttribute('data-geojson') ?? '{}',
      ) as { features?: unknown[]; geometry?: unknown }
      expect(outline.features).toEqual([])
      expect(screen.getByText(/search for a place, or choose “draw region”/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /create region and sync/i })).toBeDisabled()
      expect(
        screen.getByText(/search for a place, draw an area on the map, or enter coordinates/i),
      ).toBeVisible()
      expect(
        screen.getByRole('button', { name: /create region and sync/i }),
      ).toHaveAccessibleDescription(/search for a place, draw an area/i)
    })

    it('keeps the coordinates under "Custom area" until asked for', async () => {
      mockApi({ ...baseRoutes })
      const user = userEvent.setup()
      renderApp()

      const toggle = await screen.findByRole('button', { name: 'Custom area' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByLabelText(/West/)).not.toBeInTheDocument()

      await user.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByLabelText(/West/)).toHaveValue('')

      await user.click(toggle)
      expect(screen.queryByLabelText(/West/)).not.toBeInTheDocument()
    })

    it('syncs once coordinates are typed under "Custom area"', async () => {
      mockApi({ ...baseRoutes })
      const user = userEvent.setup()
      renderApp()

      await user.click(await screen.findByRole('button', { name: 'Custom area' }))
      await user.type(screen.getByLabelText('Name'), 'Test area')
      await user.type(screen.getByLabelText(/West/), '4.85')
      await user.type(screen.getByLabelText(/South/), '52.35')
      await user.type(screen.getByLabelText(/East/), '4.95')
      await user.type(screen.getByLabelText(/North/), '52.40')

      expect(screen.getByRole('button', { name: /create region and sync/i })).toBeEnabled()
      expect(screen.getByText(/the dashed box is the region you are about to sync/i)).toBeVisible()
    })

    it('opens "Custom area" by itself, and keeps it open, while the typed box is wrong', async () => {
      mockApi({ ...baseRoutes })
      useSession.setState({ draft: { ...amsterdamDraft, minLon: 'west' }, customAreaOpen: false })
      renderApp()

      expect(await screen.findByLabelText(/West/)).toHaveValue('west')
      const toggle = screen.getByRole('button', { name: 'Custom area' })
      expect(toggle).toHaveAttribute('aria-disabled', 'true')
      expect(toggle).toHaveAccessibleDescription(/fix the box below/i)
      expect(screen.getByText(/this box cannot be used/i)).toBeInTheDocument()

      await userEvent.click(toggle)

      expect(screen.getByLabelText(/West/)).toBeInTheDocument()
    })

    it('does not point at the section while it is closed', async () => {
      mockApi({ ...baseRoutes })
      renderApp()

      const toggle = await screen.findByRole('button', { name: 'Custom area' })
      expect(toggle).not.toHaveAttribute('aria-controls')
    })

    it('lets the section be closed again once a box that was wrong has been fixed', async () => {
      mockApi({ ...baseRoutes })
      const user = userEvent.setup()
      useSession.setState({
        draft: { ...amsterdamDraft, minLon: '5', maxLon: '4' },
        customAreaOpen: false,
      })
      renderApp()
      await user.click(await screen.findByRole('button', { name: /create region and sync/i }))
      expect(await screen.findByText('West must be smaller than east.')).toBeInTheDocument()

      const west = screen.getByLabelText(/West/)
      await user.clear(west)
      await user.type(west, '4.85')
      await user.clear(screen.getByLabelText(/East/))
      await user.type(screen.getByLabelText(/East/), '4.95')

      // The old error does not outlive the fix; the section stays open for what is being typed,
      // and the toggle works again.
      expect(screen.queryByText('West must be smaller than east.')).not.toBeInTheDocument()
      expect(screen.getByLabelText(/East/)).toHaveValue('4.95')
      const toggle = screen.getByRole('button', { name: 'Custom area' })
      expect(toggle).not.toHaveAttribute('aria-disabled', 'true')
      await user.click(toggle)
      expect(screen.queryByLabelText(/West/)).not.toBeInTheDocument()
    })

    it('fills the coordinates, names the region and opens "Custom area" when an area is drawn', async () => {
      mockApi({ ...baseRoutes })
      const user = userEvent.setup()
      renderApp()
      await user.click(await screen.findByRole('button', { name: /draw region/i }))
      const onBox = vi.mocked(startRectangleDrawing).mock.calls.at(-1)?.[1]

      act(() => {
        onBox?.([4.8, 52.3, 4.9, 52.4])
      })

      expect(await screen.findByLabelText(/West/)).toHaveValue('4.8')
      expect(screen.getByLabelText(/North/)).toHaveValue('52.4')
      expect(screen.getByLabelText('Name')).toHaveValue('Custom area')
      expect(screen.getByRole('button', { name: 'Custom area' })).toHaveAttribute(
        'aria-expanded',
        'true',
      )
      expect(screen.getByRole('button', { name: /create region and sync/i })).toBeEnabled()
    })

    it('keeps a name the user typed when an area is drawn', async () => {
      mockApi({ ...baseRoutes })
      const user = userEvent.setup()
      renderApp()
      await user.type(await screen.findByLabelText('Name'), 'My area')
      await user.click(screen.getByRole('button', { name: /draw region/i }))
      const onBox = vi.mocked(startRectangleDrawing).mock.calls.at(-1)?.[1]

      act(() => {
        onBox?.([4.8, 52.3, 4.9, 52.4])
      })

      expect(await screen.findByLabelText('Name')).toHaveValue('My area')
    })

    describe('naming the region as the area changes', () => {
      const UTRECHT = {
        id: 'R271110',
        name: 'Utrecht',
        detail: 'Utrecht, Nederland',
        kind: 'city',
        point: [5.12, 52.09],
        bbox: [5.0, 52.0, 5.2, 52.15],
      }
      const routes = {
        ...baseRoutes,
        'GET /api/v1/places': () => jsonResponse(200, { places: [UTRECHT] }),
      }

      async function chooseUtrecht(user: ReturnType<typeof userEvent.setup>) {
        await user.type(
          await screen.findByRole('combobox', { name: /search for a place/i }),
          'utrecht',
        )
        await user.click(await screen.findByRole('option', { name: /utrecht/i }))
      }

      async function drawBox(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole('button', { name: /draw region/i }))
        const onBox = vi.mocked(startRectangleDrawing).mock.calls.at(-1)?.[1]
        act(() => {
          onBox?.([4.8, 52.3, 4.9, 52.4])
        })
      }

      it('renames a region that a place named when an area is drawn instead', async () => {
        mockApi(routes)
        const user = userEvent.setup()
        renderApp()
        await chooseUtrecht(user)
        expect(screen.getByLabelText('Name')).toHaveValue('Utrecht')

        await drawBox(user)

        expect(screen.getByLabelText('Name')).toHaveValue('Custom area')
      })

      it('empties the search box when an area is drawn after a place was chosen', async () => {
        mockApi(routes)
        const user = userEvent.setup()
        renderApp()
        await chooseUtrecht(user)
        expect(screen.getByRole('combobox', { name: /search for a place/i })).toHaveValue('Utrecht')

        await drawBox(user)

        expect(screen.getByRole('combobox', { name: /search for a place/i })).toHaveValue('')
      })

      it('keeps a name the user typed over a place and over a drawn area', async () => {
        mockApi(routes)
        const user = userEvent.setup()
        renderApp()
        await chooseUtrecht(user)
        const name = screen.getByLabelText('Name')
        await user.clear(name)
        await user.type(name, 'Our office')

        await drawBox(user)
        expect(screen.getByLabelText('Name')).toHaveValue('Our office')

        await chooseUtrecht(user)
        expect(screen.getByLabelText('Name')).toHaveValue('Our office')
      })

      it('lets a place replace the name of a drawn area', async () => {
        mockApi(routes)
        const user = userEvent.setup()
        renderApp()
        await drawBox(user)
        expect(screen.getByLabelText('Name')).toHaveValue('Custom area')

        await chooseUtrecht(user)

        expect(screen.getByLabelText('Name')).toHaveValue('Utrecht')
      })
    })

    it('focuses the name when a submit fails on it while the coordinates are collapsed', async () => {
      mockApi({ ...baseRoutes })
      const user = userEvent.setup()
      useSession.setState({ draft: { ...amsterdamDraft, name: '' }, customAreaOpen: false })
      renderApp()

      await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

      expect(screen.getByText('Enter a name for the region.')).toBeInTheDocument()
      expect(screen.getByLabelText('Name')).toHaveFocus()
    })
  })

  it('explains an unreachable backend instead of showing an empty page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    renderApp()

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i)
  })

  it('says so when the organisation has no project', async () => {
    mockApi({ ...baseRoutes, 'GET /api/v1/projects': () => jsonResponse(200, { projects: [] }) })

    renderApp()

    expect(await screen.findByText(/has no project yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('shows field errors and sends nothing when the form is invalid', async () => {
    const { calls } = mockApi({ ...baseRoutes })
    const user = userEvent.setup()
    renderApp()

    await user.clear(await screen.findByLabelText('Name'))
    await user.clear(screen.getByLabelText(/West/))
    await user.type(screen.getByLabelText(/West/), 'west')
    await user.click(screen.getByRole('button', { name: /create region and sync/i }))

    expect(screen.getByText('Enter a name for the region.')).toBeInTheDocument()
    expect(screen.getByText('Enter a number such as 4.85.')).toBeInTheDocument()
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('rejects a box that is too large before calling the server', async () => {
    const { calls } = mockApi({ ...baseRoutes })
    const user = userEvent.setup()
    renderApp()

    const east = await screen.findByLabelText(/East/)
    await user.clear(east)
    await user.type(east, '9')
    await user.click(screen.getByRole('button', { name: /create region and sync/i }))

    expect(
      within(screen.getByRole('form', { name: 'Region' })).getByText(/at most 2 degrees wide/i),
    ).toBeInTheDocument()
    // the map hint names the same problem next to the box it cannot draw
    expect(screen.getByText(/this box cannot be used/i)).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('creates the region, starts the sync, follows it to success and lists the stations', async () => {
    const { calls } = mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': syncSequence(
        syncJob({ status: 'queued' }),
        syncJob({ status: 'processing' }),
        succeededJob,
      ),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByText('12 stations found')).toBeInTheDocument()
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/regions'))
    expect(post?.body).toEqual({ name: 'Amsterdam centre', bbox: [4.85, 52.35, 4.95, 52.4] })
    expect(calls.some((c) => c.path === '/api/v1/regions/r-1/syncs')).toBe(true)
    const stations = await screen.findAllByRole('listitem')
    expect(stations).toHaveLength(2)
    // Highest pm25 first: the stale station has the higher value.
    expect(within(stations[0] as HTMLElement).getByText('stale')).toBeVisible()
    expect(within(stations[1] as HTMLElement).getByText('Amsterdam-Van Diemenstraat')).toBeVisible()
    expect(within(stations[1] as HTMLElement).queryByText('stale')).not.toBeInTheDocument()
  })

  it('keeps the submit button disabled while a sync is in flight', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': syncSequence(syncJob({ status: 'processing' })),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByText('Fetching stations')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create region and sync/i })).toBeDisabled()
  })

  it('shows a failed sync in words', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': syncSequence(
        syncJob({
          status: 'failed',
          errors: [{ code: 'upstream_unauthorized', message: 'raw message' }],
        }),
      ),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected the server's api key/i)
    expect(screen.getByRole('button', { name: /create region and sync/i })).toBeEnabled()
  })

  it('retries a failed sync on the same region instead of creating a second region', async () => {
    let syncs = 0
    const { calls } = mockApi({
      ...baseRoutes,
      'POST /api/v1/regions/:id/syncs': () => {
        syncs += 1
        return jsonResponse(202, { sync_job: syncJob({ id: `job-${String(syncs)}` }) })
      },
      'GET /api/v1/syncs/:id': (call) =>
        jsonResponse(200, {
          sync_job: call.path.endsWith('job-1')
            ? syncJob({
                id: 'job-1',
                status: 'failed',
                errors: [{ code: 'timed_out', message: 'x' }],
              })
            : { ...succeededJob, id: 'job-2', map_layer_id: 'job-2' },
        }),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))
    await user.click(await screen.findByRole('button', { name: /retry sync/i }))

    expect(await screen.findByText('12 stations found')).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/regions'))).toHaveLength(1)
    expect(calls.filter((c) => c.path === '/api/v1/regions/r-1/syncs')).toHaveLength(2)
  })

  it('treats a sync with zero stations as success and says there is nothing to list', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': syncSequence({ ...succeededJob, station_count: 0 }),
      'GET /api/v1/map-layers/:id': () =>
        jsonResponse(200, {
          ...layer,
          map_layer: { ...layer.map_layer, station_count: 0, property_keys: [] },
          stations: { type: 'FeatureCollection', features: [] },
        }),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByText('No stations in this region')).toBeInTheDocument()
    expect(await screen.findByText('No stations to show.')).toBeInTheDocument()
  })

  it('explains a conflict when a sync is already running', async () => {
    mockApi({
      ...baseRoutes,
      'POST /api/v1/regions/:id/syncs': () =>
        apiError(409, 'conflict', 'A sync is already running for this region.'),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already running/i)
  })

  it('retries only the sync, without creating a second region, when starting it failed', async () => {
    let attempts = 0
    const { calls } = mockApi({
      ...baseRoutes,
      'POST /api/v1/regions/:id/syncs': () =>
        ++attempts === 1
          ? apiError(503, 'service_unavailable', 'queue down')
          : jsonResponse(202, { sync_job: syncJob() }),
      'GET /api/v1/syncs/:id': syncSequence(succeededJob),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be queued/i)
    await user.click(screen.getByRole('button', { name: /retry sync/i }))

    expect(await screen.findByText('12 stations found')).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/regions'))).toHaveLength(1)
    expect(calls.filter((c) => c.path === '/api/v1/regions/r-1/syncs')).toHaveLength(2)
  })

  it('reports a validation error from the server on the form', async () => {
    mockApi({
      ...baseRoutes,
      [REGIONS]: () =>
        apiError(400, 'validation_failed', 'bbox may span at most 2.0 degrees per side'),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/bbox may span at most/i)
  })

  it('shows an error when the sync cannot be read back', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': () => apiError(404, 'not_found', 'Sync job not found.'),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/was not found/i)
  })

  it('locks the form from the moment the sync starts, before the first poll answers', async () => {
    // The poll never answers, which is the window between "sync started" and "first status".
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': () => new Promise<Response>(() => undefined),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByText('Waiting for a worker')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create region and sync/i })).toBeDisabled()
  })

  it('stops polling and unlocks the form when a poll fails after earlier answers', async () => {
    let polls = 0
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': () => {
        polls += 1
        return polls === 1
          ? jsonResponse(200, { sync_job: syncJob({ status: 'processing' }) })
          : apiError(404, 'not_found', 'Sync job not found.')
      },
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/was not found/i)
    const pollsWhenFailed = polls
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(polls).toBe(pollsWhenFailed)
    expect(screen.getByRole('button', { name: /create region and sync/i })).toBeEnabled()
  })

  it('does not poll forever or lock the form for a status it does not know', async () => {
    let polls = 0
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': () => {
        polls += 1
        return jsonResponse(200, { sync_job: syncJob({ status: 'paused' }) })
      },
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))
    expect(await screen.findByText('Status: paused')).toBeInTheDocument()
    const pollsWhenShown = polls
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(polls).toBe(pollsWhenShown)
    expect(screen.getByRole('button', { name: /create region and sync/i })).toBeEnabled()
  })

  it('shows a loading message while the stations are fetched', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': syncSequence(succeededJob),
      'GET /api/v1/map-layers/:id': () => new Promise<Response>(() => undefined),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByText('Loading stations…')).toBeInTheDocument()
  })

  it('shows an error when the stations cannot be loaded', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': syncSequence(succeededJob),
      'GET /api/v1/map-layers/:id': () => apiError(404, 'not_found', 'Map layer not found.'),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/was not found/i)
  })

  it('moves focus to the first invalid field and links each error to its input', async () => {
    mockApi({ ...baseRoutes })
    const user = userEvent.setup()
    renderApp()

    await user.clear(await screen.findByLabelText('Name'))
    await user.click(screen.getByRole('button', { name: /create region and sync/i }))

    const name = screen.getByLabelText('Name')
    expect(name).toHaveFocus()
    expect(name).toHaveAccessibleDescription('Enter a name for the region.')
    expect(screen.getByLabelText(/West/)).not.toHaveAttribute('aria-describedby')
  })

  it('ties a box-level error to all four coordinate inputs', async () => {
    mockApi({ ...baseRoutes })
    const user = userEvent.setup()
    renderApp()

    const east = await screen.findByLabelText(/East/)
    await user.clear(east)
    await user.type(east, '9')
    await user.click(screen.getByRole('button', { name: /create region and sync/i }))

    for (const field of [/West/, /South/, /East/, /North/]) {
      const input = screen.getByLabelText(field)
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAccessibleDescription(/at most 2 degrees wide/i)
    }
    expect(screen.getByLabelText(/West/)).toHaveFocus()
  })

  it('shows the stations on a map once the sync succeeded, coloured by pm25 by default', async () => {
    mockApi({ ...baseRoutes, 'GET /api/v1/syncs/:id': syncSequence(succeededJob) })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByTestId('map')).toBeInTheDocument()
    const source = JSON.parse(
      screen.getByTestId('source-stations').getAttribute('data-geojson') ?? '{}',
    ) as { features: { properties: { value: number } }[] }
    expect(source.features.map((f) => f.properties.value)).toEqual([7.6, 36.4])
    expect(screen.getByLabelText('Pollutant')).toHaveValue('pm25')
  })

  it('recolours the map when another property is chosen', async () => {
    mockApi({ ...baseRoutes, 'GET /api/v1/syncs/:id': syncSequence(succeededJob) })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))
    await user.selectOptions(await screen.findByLabelText('Pollutant'), 'no2')

    const source = JSON.parse(
      screen.getByTestId('source-stations').getAttribute('data-geojson') ?? '{}',
    ) as { features: { properties: { value: number | null; hasValue: boolean } }[] }
    expect(source.features.map((f) => [f.properties.hasValue, f.properties.value])).toEqual([
      [true, 37.9],
      [false, null],
    ])
  })

  it('opens the station dialog from the list or the map, and closes it', async () => {
    mockApi({ ...baseRoutes, 'GET /api/v1/syncs/:id': syncSequence(succeededJob) })
    const user = userEvent.setup()
    renderApp()
    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    await user.click(await screen.findByRole('button', { name: /amsterdam city center/i }))
    expect(screen.getByRole('dialog', { name: 'Amsterdam City Center' })).toBeInTheDocument()
    // The page behind a modal is hidden from assistive technology, so look it up as hidden.
    expect(
      screen.getByRole('button', { name: /amsterdam city center/i, hidden: true }),
    ).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: /close station details/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'map: click first station' }))
    expect(screen.getByRole('dialog', { name: 'Amsterdam-Van Diemenstraat' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers no colour choice for a region without stations', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/syncs/:id': syncSequence({ ...succeededJob, station_count: 0 }),
      'GET /api/v1/map-layers/:id': () =>
        jsonResponse(200, {
          ...layer,
          map_layer: { ...layer.map_layer, station_count: 0, property_keys: [] },
          stations: { type: 'FeatureCollection', features: [] },
        }),
    })
    const user = userEvent.setup()
    renderApp()

    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByText('No stations to show.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Pollutant')).not.toBeInTheDocument()
  })

  it('shows the map straight away, before any region is synced', async () => {
    mockApi({ ...baseRoutes })

    renderApp()

    expect(await screen.findByTestId('map')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(
      screen.getByText(/the dashed box is the region you are about to sync/i),
    ).toBeInTheDocument()
  })

  it('moves the dashed box on the map as the form is edited', async () => {
    mockApi({ ...baseRoutes })
    const user = userEvent.setup()
    renderApp()

    const west = await screen.findByLabelText(/West/)
    await user.clear(west)
    await user.type(west, '4.7')

    const outline = JSON.parse(
      screen.getByTestId('source-region').getAttribute('data-geojson') ?? '{}',
    ) as { geometry: { coordinates: number[][][] } }
    expect(outline.geometry.coordinates[0]?.[0]).toEqual([4.7, 52.35])
  })

  it('keeps what was typed in the form after a sync starts', async () => {
    mockApi({ ...baseRoutes, 'GET /api/v1/syncs/:id': syncSequence(succeededJob) })
    const user = userEvent.setup()
    renderApp()

    const name = await screen.findByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'My patch')
    await user.click(screen.getByRole('button', { name: /create region and sync/i }))
    await screen.findByText('12 stations found')

    expect(screen.getByLabelText('Name')).toHaveValue('My patch')
  })

  it('filters the stations on the map from the form once a sync has succeeded', async () => {
    mockApi({ ...baseRoutes, 'GET /api/v1/syncs/:id': syncSequence(succeededJob) })
    const user = userEvent.setup()
    renderApp()
    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    await user.type(await screen.findByLabelText('Value'), '10')

    expect(await screen.findByText('Showing 1 of 2 stations.')).toBeInTheDocument()
    const source = JSON.parse(
      screen.getByTestId('source-stations').getAttribute('data-geojson') ?? '{}',
    ) as { features: { properties: { name: string } }[] }
    expect(source.features.map((f) => f.properties.name)).toEqual(['Amsterdam City Center'])
  })

  it('forgets the filter when a new region is synced', async () => {
    mockApi({ ...baseRoutes, 'GET /api/v1/syncs/:id': syncSequence(succeededJob) })
    const user = userEvent.setup()
    renderApp()
    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))
    await user.type(await screen.findByLabelText('Value'), '10')
    await screen.findByText('Showing 1 of 2 stations.')

    await user.click(screen.getByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByLabelText('Value')).toHaveValue('')
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument()
  })

  it('defines the region from a searched place: the form, the name and the map outline follow', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/places': () =>
        jsonResponse(200, {
          places: [
            {
              id: 'R271110',
              name: 'Utrecht',
              detail: 'Utrecht, Nederland',
              kind: 'city',
              point: [5.12, 52.09],
              bbox: [5.0, 52.0, 5.2, 52.15],
            },
          ],
        }),
    })
    const user = userEvent.setup()
    useSession.setState({ draft: EMPTY_DRAFT, customAreaOpen: false })
    renderApp()

    await user.type(await screen.findByRole('combobox', { name: /search for a place/i }), 'utrecht')
    await user.click(await screen.findByRole('option', { name: /utrecht/i }))

    expect(screen.getByLabelText('Name')).toHaveValue('Utrecht')
    // The numbers stay under "Custom area"; the box on the map is what shows the chosen area.
    expect(screen.queryByLabelText(/West/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Custom area' }))
    expect(screen.getByLabelText(/West/)).toHaveValue('5')
    expect(screen.getByLabelText(/North/)).toHaveValue('52.15')
    const outline = JSON.parse(
      screen.getByTestId('source-region').getAttribute('data-geojson') ?? '{}',
    ) as { geometry: { coordinates: number[][][] } }
    expect(outline.geometry.coordinates[0]?.[0]).toEqual([5, 52])
    // the form is still the place a region is submitted from
    expect(screen.getByRole('button', { name: /create region and sync/i })).toBeEnabled()
  })

  it('still lets the region be typed when the place search is down', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/places': () =>
        apiError(503, 'service_unavailable', 'Place search is unavailable right now.'),
    })
    const user = userEvent.setup()
    useSession.setState({ draft: EMPTY_DRAFT, customAreaOpen: false })
    renderApp()
    expect(await screen.findByRole('button', { name: 'Custom area' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    await user.type(await screen.findByRole('combobox', { name: /search for a place/i }), 'utrecht')
    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/type coordinates or draw an area/i)
    // The typed way is put in reach: "Custom area" opens by itself when search cannot help.
    expect(screen.getByRole('button', { name: 'Custom area' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await user.type(screen.getByLabelText('Name'), 'Typed area')
    await user.type(screen.getByLabelText(/West/), '4.85')
    await user.type(screen.getByLabelText(/South/), '52.35')
    await user.type(screen.getByLabelText(/East/), '4.95')
    await user.type(screen.getByLabelText(/North/), '52.4')
    await user.click(screen.getByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByTestId('map')).toBeInTheDocument()
  })
  describe('the country view', () => {
    const national = {
      map_layer: {
        ...layer.map_layer,
        id: 'refresh-1',
        region_id: null,
        country: 'NL',
        refreshed_at: '2026-10-03T09:00:00Z',
        bbox: [3.35, 50.75, 7.2, 53.51] as [number, number, number, number],
      },
      stations: layer.stations,
    }
    const countries = {
      countries: [
        {
          code: 'NL',
          name: 'Netherlands',
          bbox: national.map_layer.bbox,
          refreshed_at: null,
          station_count: null,
        },
        {
          code: 'TR',
          name: 'Turkey',
          bbox: [25.66, 35.82, 44.81, 42.1],
          refreshed_at: null,
          station_count: null,
        },
      ],
    }
    const routes = {
      ...baseRoutes,
      'GET /api/v1/countries': () => jsonResponse(200, countries),
      'GET /api/v1/national-layer': layerServer(national),
    }

    it('loads a national layer only when asked for and lists its stations', async () => {
      const { calls } = mockApi(routes)
      const user = userEvent.setup()
      renderApp()
      await screen.findByRole('form', { name: 'Region' })
      expect(calls.some((c) => c.path === '/api/v1/national-layer')).toBe(false)
      expect(calls.some((c) => c.path === '/api/v1/countries')).toBe(false)

      await user.click(screen.getByRole('button', { name: 'Country' }))

      expect(await screen.findAllByRole('listitem')).toHaveLength(2)
      expect(screen.getByText(/updated 1 h ago/i)).toBeVisible()
      // The Netherlands is the country shown first.
      expect(calls.find((c) => c.path === '/api/v1/national-layer')?.search).toBe('?country=NL')
      // The region form is not part of the country view.
      expect(screen.queryByRole('form', { name: 'Region' })).not.toBeInTheDocument()
    })

    it('offers the countries the server lists and asks for the added one', async () => {
      const { calls } = mockApi({
        ...routes,
        'GET /api/v1/national-layer': (call) =>
          call.search.includes('country=TR')
            ? jsonResponse(200, {
                ...national,
                map_layer: { ...national.map_layer, id: 'refresh-tr', country: 'TR' },
              })
            : layerServer(national)(call),
      })
      const user = userEvent.setup()
      renderApp()
      await user.click(await screen.findByRole('button', { name: 'Country' }))
      const picker = await screen.findByRole('combobox', { name: 'Countries' })

      await user.click(picker)
      await user.type(picker, 'turk')
      expect(screen.queryByRole('option', { name: /Netherlands/ })).not.toBeInTheDocument()
      await user.click(await screen.findByRole('option', { name: /Turkey/ }))

      await vi.waitFor(() => {
        expect(calls.some((c) => c.search.includes('country=TR'))).toBe(true)
      })
      expect(await screen.findByRole('heading', { name: 'Netherlands and Turkey' })).toBeVisible()
    })

    it('shows the chosen country even when the server lists none', async () => {
      mockApi({ ...routes, 'GET /api/v1/countries': () => jsonResponse(200, { countries: [] }) })
      const user = userEvent.setup()
      renderApp()

      await user.click(await screen.findByRole('button', { name: 'Country' }))

      const chosen = await screen.findByRole('group', { name: 'Chosen countries' })
      expect(within(chosen).getByText('NL')).toBeVisible()
    })

    it('filters through the national endpoint of the chosen country, not a sync job', async () => {
      const { calls } = mockApi(routes)
      const user = userEvent.setup()
      renderApp()
      await user.click(await screen.findByRole('button', { name: 'Country' }))
      await screen.findAllByRole('listitem')

      await user.type(await screen.findByLabelText(/value/i), '10')

      await vi.waitFor(() => {
        expect(
          calls.some(
            (c) =>
              c.path === '/api/v1/national-layer' &&
              c.search.includes('value=10') &&
              c.search.includes('country=NL'),
          ),
        ).toBe(true)
      })
      expect(calls.some((c) => c.path === '/api/v1/map-layers/refresh-1')).toBe(false)
    })

    it('says the layer is not built yet instead of showing an error', async () => {
      mockApi({
        ...routes,
        'GET /api/v1/national-layer': () =>
          apiError(404, 'not_found', 'National layer was not found.'),
      })
      const user = userEvent.setup()
      renderApp()

      await user.click(await screen.findByRole('button', { name: 'Country' }))

      expect(await screen.findByText(/has not been built yet/i)).toBeVisible()
      expect(screen.queryByText(/that was not found/i)).not.toBeInTheDocument()
    })

    describe('comparing two countries', () => {
      const germany = {
        map_layer: {
          ...national.map_layer,
          id: 'refresh-de',
          country: 'DE',
          station_count: 2,
          bbox: [5.87, 47.27, 15.04, 55.06] as [number, number, number, number],
        },
        stations: {
          type: 'FeatureCollection' as const,
          features: ['g-1', 'g-2'].map((id, i) => ({
            type: 'Feature' as const,
            id,
            geometry: { type: 'Point' as const, coordinates: [10 + i, 51] as [number, number] },
            properties: {
              name: `Station ${id}`,
              readings: {
                pm25: {
                  value: i === 0 ? 12 : 20,
                  unit: 'µg/m³',
                  observed_at: '2026-10-03T08:00:00Z',
                },
              },
            },
          })),
        },
      }
      const withGermany = {
        countries: [
          ...countries.countries,
          { ...countries.countries[0], code: 'DE', name: 'Germany', bbox: germany.map_layer.bbox },
        ],
      }
      const compareRoutes = {
        ...routes,
        'GET /api/v1/countries': () => jsonResponse(200, withGermany),
        'GET /api/v1/national-layer': (call: Parameters<ReturnType<typeof layerServer>>[0]) =>
          layerServer(call.search.includes('country=DE') ? germany : national)(call),
      }

      async function openWithGermany() {
        const mock = mockApi(compareRoutes)
        const user = userEvent.setup()
        renderApp()
        await user.click(await screen.findByRole('button', { name: 'Country' }))
        const picker = await screen.findByRole('combobox', { name: 'Countries' })
        await user.click(picker)
        await user.click(await screen.findByRole('option', { name: /Germany/ }))
        return { ...mock, user, picker }
      }

      it('puts both countries on one map and lists their stations together', async () => {
        const { calls } = await openWithGermany()

        await vi.waitFor(() => {
          expect(screen.getByText('4 stations')).toBeVisible()
        })
        expect(calls.some((c) => c.search === '?country=NL')).toBe(true)
        expect(calls.some((c) => c.search === '?country=DE')).toBe(true)
      })

      it('compares fresh readings of the chosen pollutant side by side', async () => {
        await openWithGermany()

        const table = await screen.findByRole('table')
        // The Dutch stale reading (February) is left out; only 7.6 counts there.
        const row = (name: string) =>
          within(within(table).getByRole('row', { name: new RegExp(name) }))
        await vi.waitFor(() => {
          expect(
            row('Average')
              .getAllByRole('cell')
              .map((c) => c.textContent),
          ).toEqual(['7.6', '16'])
        })
        expect(
          row('Reporting')
            .getAllByRole('cell')
            .map((c) => c.textContent),
        ).toEqual(['1 of 2', '2 of 2'])
        expect(
          row('Highest')
            .getAllByRole('cell')
            .map((c) => c.textContent),
        ).toEqual(['7.6', '20'])
      })

      it('shows the note for a country not built yet and still shows the other', async () => {
        mockApi({
          ...compareRoutes,
          'GET /api/v1/national-layer': (call) =>
            call.search.includes('country=DE')
              ? apiError(404, 'not_found', 'National layer was not found.')
              : layerServer(national)(call),
        })
        const user = userEvent.setup()
        renderApp()
        await user.click(await screen.findByRole('button', { name: 'Country' }))
        const picker = await screen.findByRole('combobox', { name: 'Countries' })
        await user.click(picker)
        await user.click(await screen.findByRole('option', { name: /Germany/ }))

        expect(await screen.findByText(/has not been built yet/i)).toBeVisible()
        expect(screen.getByText('2 stations')).toBeVisible()
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
        expect(screen.queryByText(/that was not found/i)).not.toBeInTheDocument()
      })

      it('allows no more than two countries', async () => {
        const { user, picker } = await openWithGermany()

        await user.click(picker)

        expect(await screen.findByRole('option', { name: /Turkey/ })).toHaveAttribute(
          'aria-disabled',
          'true',
        )
        expect(screen.getByText(/remove one to compare/i)).toBeVisible()
      })

      it('goes back to one country, and never to none', async () => {
        const { user } = await openWithGermany()
        await screen.findByRole('table')

        await user.click(screen.getByRole('button', { name: 'Remove Germany' }))

        await vi.waitFor(() => {
          expect(screen.queryByRole('table')).not.toBeInTheDocument()
        })
        expect(screen.getByRole('button', { name: 'Remove Netherlands' })).toBeDisabled()
      })

      it('filters each country through its own national layer', async () => {
        const { calls, user } = await openWithGermany()
        await screen.findByRole('table')

        await user.type(await screen.findByLabelText(/value/i), '15')

        await vi.waitFor(() => {
          const filtered = calls.filter((c) => c.search.includes('value=15'))
          expect(filtered.map((c) => new URLSearchParams(c.search).get('country')).sort()).toEqual([
            'DE',
            'NL',
          ])
        })
        // Above 15: Germany's 20, and the Dutch stale 36.4 (the server filters by value, not age).
        await vi.waitFor(() => {
          expect(screen.getByText(/showing 2 of 4 stations/i)).toBeVisible()
        })
      })
    })

    it('goes back to the region form', async () => {
      mockApi(routes)
      const user = userEvent.setup()
      renderApp()
      await user.click(await screen.findByRole('button', { name: 'Country' }))
      await screen.findAllByRole('listitem')

      await user.click(screen.getByRole('button', { name: 'Region' }))

      expect(await screen.findByRole('form', { name: 'Region' })).toBeInTheDocument()
    })
  })
})
