import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { layer } from '@/test/fixtures'
import { StationPopup } from './StationPopup'

const now = new Date('2026-10-03T10:00:00Z')
const [first, second] = layer.stations.features as [
  (typeof layer.stations.features)[number],
  (typeof layer.stations.features)[number],
]

describe('StationPopup', () => {
  it('shows the station name and every reading with value, unit and age', () => {
    render(<StationPopup station={first} now={now} />)

    expect(screen.getByText('Amsterdam-Van Diemenstraat')).toBeInTheDocument()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    const pm25 = rows.find((r) => within(r).queryByText('pm25'))
    expect(pm25).toHaveTextContent('7.6 µg/m³')
    expect(pm25).toHaveTextContent('2 h ago')
  })

  it('marks each stale reading individually', () => {
    const mixed = {
      ...first,
      properties: {
        name: 'Mixed',
        readings: {
          pm25: { value: 5, unit: 'µg/m³', observed_at: '2026-10-03T08:00:00Z' },
          pm10: { value: 58, unit: 'µg/m³', observed_at: '2025-01-13T23:00:00Z' },
        },
      },
    }

    render(<StationPopup station={mixed} now={now} />)

    const rows = screen.getAllByRole('row').slice(1)
    const pm10 = rows.find((r) => within(r).queryByText('pm10'))
    const pm25 = rows.find((r) => within(r).queryByText('pm25'))
    expect(within(pm10 as HTMLElement).getByText('stale')).toBeInTheDocument()
    expect(within(pm25 as HTMLElement).queryByText('stale')).not.toBeInTheDocument()
  })

  it('says so when a station reported nothing', () => {
    render(
      <StationPopup
        station={{ ...second, properties: { name: 'Quiet', readings: {} } }}
        now={now}
      />,
    )

    expect(screen.getByText(/no readings/i)).toBeInTheDocument()
  })

  it('rounds float noise in values', () => {
    const noisy = {
      ...first,
      properties: {
        name: 'Noisy',
        readings: {
          pm25: { value: 36.44749984741211, unit: 'µg/m³', observed_at: '2026-10-03T08:00:00Z' },
        },
      },
    }

    render(<StationPopup station={noisy} now={now} />)

    expect(screen.getByText('36.45 µg/m³')).toBeInTheDocument()
  })
})
