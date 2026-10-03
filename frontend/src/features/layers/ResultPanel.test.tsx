import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { amsterdamDraft, layer, layer as baseLayer } from '@/test/fixtures'
import { layerServer } from '@/test/layerServer'
import { apiError, mockApi } from '@/test/mockApi'
import { renderWithClient } from '@/test/renderWithClient'
import { EMPTY_DRAFT } from '@/features/regions/validation'
import { useSession } from '@/stores/session'
import { startRectangleDrawing } from './regionDrawing'
import { ResultPanel } from './ResultPanel'

vi.mock('react-map-gl/maplibre', async () => await import('@/test/mockMapLibre'))
vi.mock('@/features/layers/filterTiming', () => ({ FILTER_DEBOUNCE_MS: 60 }))
vi.mock('./regionDrawing', () => ({ startRectangleDrawing: vi.fn(() => vi.fn()) }))

const now = new Date('2026-10-03T10:00:00Z')
const LAYER_ROUTE = 'GET /api/v1/map-layers/:id'

function panel(withLayer = true) {
  return renderWithClient(<ResultPanel layer={withLayer ? layer : null} now={now} idle />)
}

function mapStations(): { name: string; value: number | null }[] {
  const data = JSON.parse(
    screen.getByTestId('source-stations').getAttribute('data-geojson') ?? '{}',
  ) as { features: { properties: { name: string; value: number | null } }[] }
  return data.features.map((f) => ({ name: f.properties.name, value: f.properties.value }))
}

beforeEach(() => {
  useSession.getState().reset()
  useSession.setState({ draft: amsterdamDraft })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ResultPanel', () => {
  it('asks for an area, without a box or a complaint, while none has been chosen', () => {
    mockApi({})
    useSession.setState({ draft: EMPTY_DRAFT })

    panel(false)

    expect(screen.getByText(/search for a place, or choose “draw region”/i)).toBeInTheDocument()
    expect(screen.queryByText(/this box cannot be used/i)).not.toBeInTheDocument()
  })

  it('ignores a remembered station that is not in this layer', () => {
    mockApi({})
    useSession.getState().selectStation('station-from-an-earlier-sync')

    panel()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /amsterdam city center/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('ignores a remembered pollutant the layer does not have', () => {
    mockApi({})
    useSession.getState().setColourProperty('o3')

    panel()

    expect(screen.getByLabelText('Pollutant')).toHaveValue('pm25')
  })

  it('keeps a remembered pollutant the layer does have', () => {
    mockApi({})
    useSession.getState().setColourProperty('no2')

    panel()

    expect(screen.getByLabelText('Pollutant')).toHaveValue('no2')
  })

  it('shows the map and a hint, but no list, pollutant or filter, before any sync', () => {
    mockApi({})

    panel(false)

    expect(screen.getByTestId('map')).toBeInTheDocument()
    expect(screen.getByText(/press .create region and sync./i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Pollutant')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('outlines the form box on the map and follows edits', () => {
    mockApi({})
    const { rerender } = panel(false)
    const outline = () =>
      JSON.parse(screen.getByTestId('source-region').getAttribute('data-geojson') ?? '{}') as {
        geometry?: { coordinates: number[][][] }
      }
    expect(outline().geometry?.coordinates[0]?.[0]).toEqual([4.85, 52.35])

    useSession.getState().setDraftField('minLon', '4.8')
    rerender(<ResultPanel layer={null} now={now} idle />)

    expect(outline().geometry?.coordinates[0]?.[0]).toEqual([4.8, 52.35])
  })

  it('does not tell the user to press the button while a sync is running or stations load', () => {
    mockApi({})

    renderWithClient(<ResultPanel layer={null} now={now} idle={false} />)

    expect(screen.queryByText(/press .create region and sync./i)).not.toBeInTheDocument()
  })

  it('explains what is wrong when the typed box cannot be drawn', () => {
    mockApi({})
    useSession.getState().setDraftField('maxLon', '9')

    panel(false)

    expect(screen.getByText(/this box cannot be used: .*at most 2 degrees/i)).toBeInTheDocument()
  })

  it('names the map region and ties the hint to it', () => {
    mockApi({})

    panel(false)

    expect(screen.getByRole('region', { name: /map/i })).toHaveAccessibleDescription(/dashed box/i)
  })
})

describe('ResultPanel filter', () => {
  it('shows only the stations the server says match, and says how many', async () => {
    const { calls } = mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), '10')

    await screen.findByText('Showing 1 of 2 stations.')
    const request = calls.find((c) => c.search !== '')
    expect(Object.fromEntries(new URLSearchParams(request?.search))).toEqual({
      property: 'pm25',
      comparator: '>',
      value: '10',
    })
    expect(mapStations().map((s) => s.name)).toEqual(['Amsterdam City Center'])
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
  })

  it('sends one request after typing pauses, not one per keystroke', async () => {
    const { calls } = mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), '25')
    await screen.findByText(/showing/i)

    const filtered = calls.filter((c) => c.search !== '')
    expect(new Set(filtered.map((c) => new URLSearchParams(c.search).get('value')))).toEqual(
      new Set(['25']),
    )
  })

  it('changes the result when the comparator changes', async () => {
    mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()
    await user.type(screen.getByLabelText('Value'), '10')
    await screen.findByText('Showing 1 of 2 stations.')

    await user.selectOptions(screen.getByLabelText('Comparison'), 'less than')

    await waitFor(() => {
      expect(mapStations().map((s) => s.name)).toEqual(['Amsterdam-Van Diemenstraat'])
    })
  })

  it('applies the filter to the pollutant chosen above', async () => {
    const { calls } = mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()
    await user.selectOptions(screen.getByLabelText('Pollutant'), 'no2')

    await user.type(screen.getByLabelText('Value'), '30')

    await screen.findByText('Showing 1 of 2 stations.')
    const request = calls.filter((c) => c.search !== '').at(-1)
    expect(new URLSearchParams(request?.search).get('property')).toBe('no2')
    expect(mapStations().map((s) => s.name)).toEqual(['Amsterdam-Van Diemenstraat'])
  })

  it('keeps the colour scale of the whole layer while filtering', async () => {
    mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), '30')
    await screen.findByText('Showing 1 of 2 stations.')

    const legend = screen.getByRole('group', { name: /legend/i })
    expect(legend).toHaveTextContent('7.6')
    expect(legend).toHaveTextContent('36.4')
  })

  it('sends nothing and explains an invalid number', async () => {
    const { calls } = mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), 'high')
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(screen.getByText('Enter a number such as 10 or -3.5.')).toBeInTheDocument()
    expect(screen.getByLabelText('Value')).toHaveAccessibleDescription(/enter a number/i)
    expect(calls).toHaveLength(0)
    expect(mapStations()).toHaveLength(2)
  })

  it('shows every station again, at once, when the filter is cleared', async () => {
    mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()
    await user.type(screen.getByLabelText('Value'), '10')
    await screen.findByText('Showing 1 of 2 stations.')

    await user.click(screen.getByRole('button', { name: /clear filter/i }))

    expect(mapStations()).toHaveLength(2)
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Value')).toHaveValue('')
  })

  it('says so, on the map and in the list, when nothing matches', async () => {
    mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), '1000')

    await screen.findAllByText('No stations match this filter.')
    expect(mapStations()).toEqual([])
    expect(
      screen
        .getAllByRole('status')
        .some((el) => el.textContent === 'No stations match this filter.'),
    ).toBe(true)
  })

  it('shows the server error when the filter is rejected', async () => {
    mockApi({
      [LAYER_ROUTE]: () => apiError(400, 'validation_failed', 'property must be one of: x'),
    })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), '10')

    expect(await screen.findByRole('alert')).toHaveTextContent(/property must be one of/i)
  })

  it('opens no dialog for a selected station the filter has removed', async () => {
    mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    // A modal dialog makes the filter unreachable, so the filter is set before the station is
    // selected: the selected station (f-1, 7.6) does not match "pm25 > 30".
    useSession.setState({ filterValue: '30', selectedStationId: 'f-1' })
    panel()

    await screen.findByText('Showing 1 of 2 stations.')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('accepts a decimal comma', async () => {
    const { calls } = mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), '7,6')

    await screen.findByText(/showing/i)
    expect(new URLSearchParams(calls.find((c) => c.search !== '')?.search).get('value')).toBe('7.6')
  })

  it('says the result is updating, instead of describing the old filter, when the pollutant changes', async () => {
    let release: (() => void) | undefined
    const server = layerServer(layer)
    mockApi({
      [LAYER_ROUTE]: async (call) => {
        if (new URLSearchParams(call.search).get('property') === 'no2') {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return server(call)
      },
    })
    const user = userEvent.setup({ delay: null })
    panel()
    await user.type(screen.getByLabelText('Value'), '10')
    await screen.findByText('Showing 1 of 2 stations.')

    await user.selectOptions(screen.getByLabelText('Pollutant'), 'no2')

    await screen.findByText('Updating…')
    expect(screen.queryByText(/showing 1 of 2/i)).not.toBeInTheDocument()
    release?.()
    await screen.findByText('Showing 1 of 2 stations.')
    expect(screen.queryByText('Updating…')).not.toBeInTheDocument()
  })

  it('applies a changed pollutant or comparator at once, but waits for typing to pause', async () => {
    const { calls } = mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()
    await user.type(screen.getByLabelText('Value'), '10')
    await screen.findByText('Showing 1 of 2 stations.')
    const before = calls.length

    await user.selectOptions(screen.getByLabelText('Comparison'), 'less than')

    // Well inside the debounce window: no waiting for typing, since nothing is being typed.
    await waitFor(
      () => {
        expect(calls.length).toBeGreaterThan(before)
      },
      { timeout: 30 },
    )
  })

  it('counts what is drawn: the number shown always equals the stations on the map and in the list', async () => {
    mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), '10')

    await screen.findByText('Showing 1 of 2 stations.')
    expect(mapStations()).toHaveLength(1)
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1)
  })

  it('ignores a filtered answer that belongs to another layer', async () => {
    const other = { ...baseLayer, map_layer: { ...baseLayer.map_layer, id: 'job-2' } }
    const server = layerServer(layer)
    mockApi({
      [LAYER_ROUTE]: async (call) => {
        if (call.path.endsWith('job-2')) return await new Promise<Response>(() => undefined)
        return server(call)
      },
    })
    const user = userEvent.setup({ delay: null })
    const { rerender } = panel()
    await user.type(screen.getByLabelText('Value'), '10')
    await screen.findByText('Showing 1 of 2 stations.')

    rerender(<ResultPanel layer={other} now={now} idle />)

    // The earlier layer's answer must not decide what this layer shows.
    expect(mapStations()).toHaveLength(2)
    expect(screen.queryByText('Showing 1 of 2 stations.')).not.toBeInTheDocument()
  })

  it('shows the answer to the latest filter when an older request finishes last', async () => {
    let finishSlow: (() => void) | undefined
    const server = layerServer(layer)
    mockApi({
      [LAYER_ROUTE]: async (call) => {
        if (new URLSearchParams(call.search).get('value') === '10') {
          await new Promise<void>((resolve) => {
            finishSlow = resolve
          })
        }
        return server(call)
      },
    })
    const user = userEvent.setup({ delay: null })
    panel()
    await user.type(screen.getByLabelText('Value'), '10')
    await waitFor(() => {
      expect(finishSlow).toBeDefined()
    })

    await user.clear(screen.getByLabelText('Value'))
    await user.type(screen.getByLabelText('Value'), '30')
    await screen.findByText('Showing 1 of 2 stations.')
    finishSlow?.()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(mapStations().map((s) => s.name)).toEqual(['Amsterdam City Center'])
    expect(screen.getByLabelText('Value')).toHaveValue('30')
  })

  it('reports an invalid number only once typing pauses, and announces it', async () => {
    mockApi({ [LAYER_ROUTE]: layerServer(layer) })
    const user = userEvent.setup({ delay: null })
    panel()

    await user.type(screen.getByLabelText('Value'), '-')
    expect(screen.queryByText('Enter a number such as 10 or -3.5.')).not.toBeInTheDocument()

    await screen.findByText('Enter a number such as 10 or -3.5.')
    expect(screen.getByText('Enter a number such as 10 or -3.5.')).toHaveAttribute(
      'aria-live',
      'polite',
    )
  })
})

describe('ResultPanel drawing', () => {
  it('writes a drawn box into the region form values, which also moves the outline', async () => {
    mockApi({})
    const user = userEvent.setup({ delay: null })
    panel(false)

    await user.click(screen.getByRole('button', { name: /draw region/i }))
    const finish = vi.mocked(startRectangleDrawing).mock.calls.at(-1)?.[1]
    act(() => {
      finish?.([4.7, 52.3, 4.8, 52.35])
    })

    const { draft } = useSession.getState()
    expect([draft.minLon, draft.minLat, draft.maxLon, draft.maxLat]).toEqual([
      '4.7',
      '52.3',
      '4.8',
      '52.35',
    ])
    const outline = JSON.parse(
      screen.getByTestId('source-region').getAttribute('data-geojson') ?? '{}',
    ) as { geometry: { coordinates: number[][][] } }
    expect(outline.geometry.coordinates[0]?.[0]).toEqual([4.7, 52.3])
  })

  it('names the problem when a drawn box is too large to use', async () => {
    mockApi({})
    const user = userEvent.setup({ delay: null })
    panel(false)

    await user.click(screen.getByRole('button', { name: /draw region/i }))
    const finish = vi.mocked(startRectangleDrawing).mock.calls.at(-1)?.[1]
    act(() => {
      finish?.([3, 51, 7, 53])
    })

    expect(screen.getByText(/this box cannot be used: .*at most 2 degrees/i)).toBeInTheDocument()
    expect(useSession.getState().draft.maxLon).toBe('7')
  })
})
