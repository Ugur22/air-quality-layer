import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { apiError, jsonResponse, mockApi } from '@/test/mockApi'
import { layer } from '@/test/fixtures'
import { renderWithClient } from '@/test/renderWithClient'
import { StationDialog } from './StationDialog'
import type { StationFeature, StationHistory } from './types'

const now = new Date('2026-10-03T10:00:00Z')
const stations = layer.stations.features
const [first, second] = stations as [StationFeature, StationFeature]
const HISTORY_ROUTE = 'GET /api/v1/map-layers/:id/stations/:sid/history'

function history(overrides: Partial<StationHistory> = {}): StationHistory {
  return {
    property: 'pm25',
    unit: 'µg/m³',
    interval: 'hour',
    from: '2026-10-02T10:00:00Z',
    to: '2026-10-03T10:00:00Z',
    points: [
      { at: '2026-10-03T07:00:00Z', value: 4.5 },
      { at: '2026-10-03T08:00:00Z', value: 31 },
      { at: '2026-10-03T09:00:00Z', value: 10.9 },
    ],
    ...overrides,
  }
}

function open(
  station: StationFeature = first,
  property: string | null = 'pm25',
  onClose = vi.fn(),
) {
  renderWithClient(
    <StationDialog
      station={station}
      stations={stations}
      layerId="job-1"
      property={property}
      now={now}
      onClose={onClose}
    />,
  )
  return onClose
}

describe('StationDialog', () => {
  it('names the station and says where it is and how fresh it is', () => {
    open()

    const dialog = screen.getByRole('dialog', { name: 'Amsterdam-Van Diemenstraat' })
    expect(dialog).toHaveTextContent('52.3900°N, 4.8800°E')
    expect(dialog).toHaveTextContent('latest 2 h ago')
  })

  it('writes south and west coordinates with their hemisphere instead of a minus sign', () => {
    open({ ...first, geometry: { type: 'Point', coordinates: [-70.6693, -33.4489] } })

    expect(screen.getByRole('dialog')).toHaveTextContent('33.4489°S, 70.6693°W')
  })

  it('moves between the tabs with the arrow keys, Home and End, keeping only one in the Tab order', async () => {
    mockApi({ [HISTORY_ROUTE]: () => jsonResponse(200, { history: history() }) })
    const user = userEvent.setup()
    open()
    const overview = screen.getByRole('tab', { name: 'Overview' })
    const trend = screen.getByRole('tab', { name: 'Trend' })
    expect(overview).toHaveAttribute('tabindex', '0')
    expect(trend).toHaveAttribute('tabindex', '-1')

    overview.focus()
    await user.keyboard('{ArrowRight}')
    expect(trend).toHaveFocus()
    expect(trend).toHaveAttribute('aria-selected', 'true')
    expect(trend).toHaveAttribute('tabindex', '0')

    await user.keyboard('{ArrowRight}')
    expect(overview).toHaveFocus()
    await user.keyboard('{End}')
    expect(trend).toHaveFocus()
    await user.keyboard('{Home}')
    expect(overview).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(trend).toHaveFocus()
  })

  it('describes the trend chart with its values, not only its topic', async () => {
    mockApi({ [HISTORY_ROUTE]: () => jsonResponse(200, { history: history() }) })
    const user = userEvent.setup()
    open()

    await user.click(screen.getByRole('tab', { name: 'Trend' }))

    expect(
      await screen.findByRole('img', {
        name: 'pm25 over the last 24 hours: latest 10.9 µg/m³ (WHO class ≤ 15), lowest 4.5, highest 31',
      }),
    ).toBeInTheDocument()
  })

  it('names the WHO class of the latest trend value and explains the bands', async () => {
    mockApi({ [HISTORY_ROUTE]: () => jsonResponse(200, { history: history() }) })
    const user = userEvent.setup()
    open()

    await user.click(screen.getByRole('tab', { name: 'Trend' }))

    const panel = await screen.findByRole('tabpanel')
    await within(panel).findByRole('img')
    expect(panel).toHaveTextContent(/WHO 2021 24-hour guideline levels/)
    expect(panel).toHaveTextContent('≤ 15 µg/m³')
    expect(panel).toHaveTextContent(/one high hour does not mean the day exceeds/i)
  })

  it('shows the WHO class next to the overview value and explains the bands', () => {
    open(second)

    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveTextContent(/WHO 2021 24-hour guideline levels/)
    expect(panel).toHaveTextContent('> 75')
  })

  it('closes from the close button and from Escape', async () => {
    const user = userEvent.setup()
    const onClose = open()

    await user.click(screen.getByRole('button', { name: /close station details/i }))
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('opens on the overview, with the value, its rank among the stations and the median', () => {
    open(second)

    const panel = screen.getByRole('tabpanel', { name: 'Overview' })
    expect(panel).toHaveTextContent('36.4')
    expect(panel).toHaveTextContent('1st highest')
    expect(panel).toHaveTextContent('of 2 stations in this region')
    expect(
      within(panel).getByText(/is 36.4 µg\/m³, 1st highest of 2\. The median is 22\./),
    ).toBeInTheDocument()
  })

  it('lists every reading and marks the one the map is coloured by', () => {
    open()

    const readings = within(screen.getByRole('region', { name: 'All readings' }))
    const items = readings.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    const pm25 = items.find((li) => within(li).queryByText('pm25'))
    const no2 = items.find((li) => within(li).queryByText('no2'))
    expect(pm25).toHaveAttribute('aria-current', 'true')
    expect(no2).not.toHaveAttribute('aria-current')
    expect(pm25).toHaveTextContent('7.6')
  })

  it('marks a stale reading', () => {
    open(second)

    expect(screen.getByText('stale')).toBeInTheDocument()
  })

  it('says so, and ranks nothing, for a station without the chosen pollutant', () => {
    const quiet = { ...first, properties: { name: 'Quiet', readings: {} } }
    open(quiet)

    expect(screen.getByRole('tabpanel', { name: 'Overview' })).toHaveTextContent(
      'This station reports no pm25.',
    )
    expect(screen.getByText('No readings reported by this station.')).toBeInTheDocument()
  })

  it('does not ask for the trend until the Trend tab is opened', async () => {
    const { calls } = mockApi({ [HISTORY_ROUTE]: () => jsonResponse(200, { history: history() }) })
    const user = userEvent.setup()
    open()

    expect(calls).toHaveLength(0)

    await user.click(screen.getByRole('tab', { name: 'Trend' }))
    await screen.findByText('Latest')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(`/api/v1/map-layers/job-1/stations/${first.id}/history`)
    const query = new URLSearchParams(calls[0]?.search)
    expect(query.get('property')).toBe('pm25')
    expect(query.get('hours')).toBe('24')
  })

  it('shows the latest, lowest and highest value of the trend', async () => {
    mockApi({ [HISTORY_ROUTE]: () => jsonResponse(200, { history: history() }) })
    const user = userEvent.setup()
    open()

    await user.click(screen.getByRole('tab', { name: 'Trend' }))

    const stats = await screen.findByText('Latest')
    const list = stats.closest('dl') as HTMLElement
    expect(within(list).getByText('Lowest').nextElementSibling).toHaveTextContent('4.5')
    expect(within(list).getByText('Highest').nextElementSibling).toHaveTextContent('31')
    expect(within(list).getByText('Latest').nextElementSibling).toHaveTextContent('10.9')
  })

  it('says the station has no readings in the window instead of drawing an empty chart', async () => {
    mockApi({ [HISTORY_ROUTE]: () => jsonResponse(200, { history: history({ points: [] }) }) })
    const user = userEvent.setup()
    open()

    await user.click(screen.getByRole('tab', { name: 'Trend' }))

    expect(await screen.findByText(/no pm25 readings in the last 24 hours/i)).toBeInTheDocument()
  })

  it('says the station has no sensor for the pollutant', async () => {
    mockApi({
      [HISTORY_ROUTE]: () => jsonResponse(200, { history: history({ points: [], unit: null }) }),
    })
    const user = userEvent.setup()
    open()

    await user.click(screen.getByRole('tab', { name: 'Trend' }))

    expect(await screen.findByText(/has no pm25 sensor/i)).toBeInTheDocument()
  })

  it("shows the server's words when the trend is unavailable, and tries again on request", async () => {
    let answer = 0
    const { calls } = mockApi({
      [HISTORY_ROUTE]: () =>
        ++answer === 1
          ? apiError(
              503,
              'service_unavailable',
              'The trend is unavailable right now. Try again in a moment.',
            )
          : jsonResponse(200, { history: history() }),
    })
    const user = userEvent.setup()
    open()

    await user.click(screen.getByRole('tab', { name: 'Trend' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The trend is unavailable right now. Try again in a moment.',
    )

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Latest')).toBeInTheDocument()
    expect(calls).toHaveLength(2)
  })

  it('does not ask for a trend when there is no pollutant', async () => {
    const { calls } = mockApi({})
    const user = userEvent.setup()
    open(first, null)

    await user.click(screen.getByRole('tab', { name: 'Trend' }))

    expect(screen.getByText('This layer has no pollutant to chart.')).toBeInTheDocument()
    await waitFor(() => {
      expect(calls).toHaveLength(0)
    })
  })

  it('shows a loading message while the trend is fetched', async () => {
    let release: (() => void) | undefined
    mockApi({
      [HISTORY_ROUTE]: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return jsonResponse(200, { history: history() })
      },
    })
    const user = userEvent.setup()
    open()

    await user.click(screen.getByRole('tab', { name: 'Trend' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Loading the last 24 hours')
    release?.()
    expect(await screen.findByText('Latest')).toBeInTheDocument()
  })
})
