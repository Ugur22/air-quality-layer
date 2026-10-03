import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { layerServer } from '@/test/layerServer'
import { apiError, jsonResponse, mockApi } from '@/test/mockApi'
import { layer, project, region, succeededJob, syncJob } from '@/test/fixtures'
import { renderApp } from '@/test/renderApp'
import { useSession } from '@/stores/session'
import type { SyncJob } from '@/features/syncs/types'

vi.mock('react-map-gl/maplibre', async () => await import('@/test/mockMapLibre'))

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
  useSession.getState().resetDraft()
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

  it('opens with a working example region filled in', async () => {
    mockApi({ ...baseRoutes })

    renderApp()

    expect(await screen.findByLabelText('Name')).toHaveValue('Amsterdam centre')
    expect(screen.getByLabelText(/West/)).toHaveValue('4.85')
    expect(screen.getByLabelText(/North/)).toHaveValue('52.40')
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

    expect(await screen.findByText('Fetching stations from OpenAQ')).toBeInTheDocument()
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

  it('opens a popup when a station is clicked in the list or on the map, and closes it', async () => {
    mockApi({ ...baseRoutes, 'GET /api/v1/syncs/:id': syncSequence(succeededJob) })
    const user = userEvent.setup()
    renderApp()
    await user.click(await screen.findByRole('button', { name: /create region and sync/i }))

    await user.click(await screen.findByRole('button', { name: /amsterdam city center/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Amsterdam City Center')
    expect(screen.getByRole('button', { name: /amsterdam city center/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(screen.getByRole('button', { name: 'map: click first station' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Amsterdam-Van Diemenstraat')

    await user.click(screen.getByRole('button', { name: 'map: click empty ground' }))
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
    renderApp()

    await user.type(await screen.findByRole('combobox', { name: /search for a place/i }), 'utrecht')
    await user.click(await screen.findByRole('option', { name: /utrecht/i }))

    expect(screen.getByLabelText('Name')).toHaveValue('Utrecht')
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
    renderApp()

    await user.type(await screen.findByRole('combobox', { name: /search for a place/i }), 'utrecht')
    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/i)
    await user.click(screen.getByRole('button', { name: /create region and sync/i }))

    expect(await screen.findByTestId('map')).toBeInTheDocument()
  })
})
