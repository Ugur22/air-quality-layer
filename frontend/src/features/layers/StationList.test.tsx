import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { layer } from '@/test/fixtures'
import type { StationFeature } from './types'
import { StationList } from './StationList'

const now = new Date('2026-10-03T10:00:00Z')
const [first, second] = layer.stations.features as [StationFeature, StationFeature]

function withTimes(times: string[]): StationFeature {
  return {
    ...first,
    properties: {
      name: 'Mixed formats',
      readings: Object.fromEntries(
        times.map((t, i) => [`p${String(i)}`, { value: 1, unit: 'x', observed_at: t }]),
      ),
    },
  }
}

describe('StationList', () => {
  it('lists each station with its reading count and age', () => {
    render(
      <StationList stations={[first, second]} selectedId={null} onSelect={vi.fn()} now={now} />,
    )

    expect(screen.getByText('Amsterdam-Van Diemenstraat')).toBeInTheDocument()
    expect(screen.getByText(/2 readings, latest 2 h ago/)).toBeInTheDocument()
    expect(screen.getByText(/1 reading, latest 7 months ago/)).toBeInTheDocument()
  })

  it('marks only the station whose newest reading is 24 hours old or older', () => {
    render(
      <StationList stations={[first, second]} selectedId={null} onSelect={vi.fn()} now={now} />,
    )

    expect(screen.getAllByText('stale')).toHaveLength(1)
  })

  it('picks the newest reading by instant, not by how the timestamp text sorts', () => {
    // As text, the second sorts later; as instants it is exactly 24 h old (stale) while the first
    // (17 h old) is the newest, so the station must not be marked stale.
    const station = withTimes(['2026-10-02T12:00:00-05:00', '2026-10-03T00:00:00+14:00'])

    render(<StationList stations={[station]} selectedId={null} onSelect={vi.fn()} now={now} />)

    expect(screen.queryByText('stale')).not.toBeInTheDocument()
    expect(screen.getByText(/latest 17 h ago/)).toBeInTheDocument()
  })

  it("shows the chosen property's value and unit, and nothing for a station without it", () => {
    const only = withTimes(['2026-10-03T09:00:00Z'])
    render(
      <StationList
        stations={[first, only]}
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        property="p0"
      />,
    )

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0] as HTMLElement).queryByText(/µg/)).not.toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('p0:')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('x')).toBeInTheDocument()
  })

  it('says so when there are no stations', () => {
    render(<StationList stations={[]} selectedId={null} onSelect={vi.fn()} now={now} />)

    expect(screen.getByText('No stations to show.')).toBeInTheDocument()
  })
})
