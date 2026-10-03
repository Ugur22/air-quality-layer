import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE_MAP, mapSpies } from '@/test/mapSpies'
import { startRectangleDrawing } from './regionDrawing'
import { layer } from '@/test/fixtures'
import { StationMap } from './StationMap'

vi.mock('react-map-gl/maplibre', async () => await import('@/test/mockMapLibre'))
vi.mock('./regionDrawing', () => ({ startRectangleDrawing: vi.fn() }))

const now = new Date('2026-10-03T10:00:00Z')

function stationsSource(): { features: { properties: Record<string, unknown> }[] } {
  return JSON.parse(screen.getByTestId('source-stations').getAttribute('data-geojson') ?? '{}') as {
    features: { properties: Record<string, unknown> }[]
  }
}

beforeEach(() => {
  mapSpies.fitBounds.mockClear()
  vi.mocked(startRectangleDrawing).mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
})

describe('StationMap', () => {
  it('hands the chosen property of every station to the map source', () => {
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    expect(stationsSource().features.map((f) => f.properties.value)).toEqual([7.6, 36.4])
  })

  it("writes each station's value next to its marker, from the label in the source", () => {
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    const layout = JSON.parse(
      screen.getByTestId('layer-station-values').getAttribute('data-layout') ?? '{}',
    ) as Record<string, unknown>
    expect(layout['text-field']).toEqual(['get', 'label'])
    expect(stationsSource().features.map((f) => f.properties.label)).toEqual(['7.6', '36.4'])
  })

  it('explains the marker and the stations without a reading in the legend', () => {
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    const legend = screen.getByRole('group', { name: /legend/i })
    expect(legend).toHaveTextContent(/latest pm25 reading/i)
    expect(legend).toHaveTextContent(/–.*no usable pm25 value/i)
  })

  it('draws the outline of the box in the form', () => {
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    const outline = JSON.parse(
      screen.getByTestId('source-region').getAttribute('data-geojson') ?? '{}',
    ) as { geometry: { coordinates: number[][][] } }
    expect(outline.geometry.coordinates[0]).toEqual([
      [4.85, 52.35],
      [4.95, 52.35],
      [4.95, 52.4],
      [4.85, 52.4],
      [4.85, 52.35],
    ])
  })

  it('uses the configured basemap style', () => {
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    expect(screen.getByTestId('map').getAttribute('data-style')).toMatch(/^https:\/\//)
  })

  it('reports the station id when a station is clicked and clears on empty ground', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={onSelect}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'map: click first station' }))
    await user.click(screen.getByRole('button', { name: 'map: click empty ground' }))

    expect(onSelect).toHaveBeenNthCalledWith(1, 'f-1')
    expect(onSelect).toHaveBeenNthCalledWith(2, null)
  })

  it('shows a tooltip with the name and value while the pointer is on a station', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'map: hover first station' }))

    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Amsterdam-Van Diemenstraat')
    expect(tip).toHaveTextContent('pm25 7.6 µg/m³')
    expect(tip).toHaveTextContent(/click for details/i)
    expect(tip).toHaveStyle({ left: '24px', top: '34px' })
  })

  it('removes the tooltip when the pointer moves to empty ground or leaves the map', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'map: hover first station' }))
    await user.click(screen.getByRole('button', { name: 'map: hover empty ground' }))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'map: hover first station' }))
    await user.click(screen.getByRole('button', { name: 'map: pointer leaves' }))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('says a station has no reading of the property in its tooltip', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <StationMap
        layer={layer}
        property="o3"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'map: hover first station' }))

    expect(screen.getByRole('tooltip')).toHaveTextContent('o3 not reported')
  })

  it('explains the colours: the range with its unit, faded means stale, hollow means no value', () => {
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    const legend = screen.getByRole('group', { name: /legend/i })
    expect(legend).toHaveTextContent('pm25')
    expect(legend).toHaveTextContent('7.6')
    expect(legend).toHaveTextContent('36.4')
    expect(legend).toHaveTextContent('µg/m³')
    expect(legend).toHaveTextContent(/faded/i)
    expect(legend).toHaveTextContent(/hollow/i)
  })

  it('shows a legend note instead of a range when no station has the property', () => {
    render(
      <StationMap
        layer={layer}
        property="o3"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    expect(screen.getByRole('group', { name: /legend/i })).toHaveTextContent(
      /no station reports o3/i,
    )
  })

  it('rounds float noise in the legend range', () => {
    const noisy = structuredClone(layer)
    const second = noisy.stations.features[1]
    if (second)
      second.properties.readings.pm25 = {
        value: 36.44749984741211,
        unit: 'µg/m³',
        observed_at: '2026-10-03T08:00:00Z',
      }

    render(
      <StationMap
        layer={noisy}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    const legend = screen.getByRole('group', { name: /legend/i })
    expect(legend).toHaveTextContent('36.45')
    expect(legend).not.toHaveTextContent('36.4474')
  })

  it('says how many stations use another unit and are left off the scale', () => {
    const mixed = structuredClone(layer)
    const second = mixed.stations.features[1]
    if (second)
      second.properties.readings.pm25 = {
        value: 0.01,
        unit: 'ppm',
        observed_at: '2026-10-03T08:00:00Z',
      }

    render(
      <StationMap
        layer={mixed}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    expect(screen.getByRole('group', { name: /legend/i })).toHaveTextContent(
      /1 station reports pm25 in another unit/i,
    )
  })

  it('shows the map before any sync, with the typed box as the outline and no legend', () => {
    render(
      <StationMap
        layer={null}
        draftBbox={[4.85, 52.35, 4.95, 52.4]}
        property={null}
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
      />,
    )

    expect(screen.getByTestId('map')).toBeInTheDocument()
    const outline = JSON.parse(
      screen.getByTestId('source-region').getAttribute('data-geojson') ?? '{}',
    ) as { geometry: { coordinates: number[][][] } }
    expect(outline.geometry.coordinates[0]?.[0]).toEqual([4.85, 52.35])
    expect(
      JSON.parse(screen.getByTestId('source-stations').getAttribute('data-geojson') ?? '{}'),
    ).toEqual({ type: 'FeatureCollection', features: [] })
    expect(screen.queryByRole('group', { name: /legend/i })).not.toBeInTheDocument()
  })

  it('draws no outline while the typed box is not a valid one', () => {
    render(
      <StationMap
        layer={null}
        draftBbox={null}
        property={null}
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
      />,
    )

    expect(
      JSON.parse(screen.getByTestId('source-region').getAttribute('data-geojson') ?? '{}'),
    ).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('says "stations ... are" for several stations in another unit', () => {
    const mixed = structuredClone(layer)
    const base = mixed.stations.features[0]
    if (!base) throw new Error('fixture has no station')
    const clone = (id: string, unit: string): typeof base => ({
      ...structuredClone(base),
      id,
      properties: {
        name: id,
        readings: { pm25: { value: 5, unit, observed_at: '2026-10-03T08:00:00Z' } },
      },
    })
    // Three stations in µg/m³ (the common unit) and two in ppm.
    mixed.stations.features = [
      clone('a', 'µg/m³'),
      clone('b', 'µg/m³'),
      clone('c', 'µg/m³'),
      clone('d', 'ppm'),
      clone('e', 'ppm'),
    ]

    render(
      <StationMap
        layer={mixed}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    expect(screen.getByRole('group', { name: /legend/i }).textContent).toMatch(
      /2 stations report pm25 in another unit and are left off/i,
    )
  })

  it('draws the synced region too, in its own style, when the form box has moved away from it', () => {
    render(
      <StationMap
        layer={layer}
        draftBbox={[4.7, 52.3, 4.8, 52.35]}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
      />,
    )

    const synced = JSON.parse(
      screen.getByTestId('source-synced').getAttribute('data-geojson') ?? '{}',
    ) as { geometry: { coordinates: number[][][] } }
    expect(synced.geometry.coordinates[0]?.[0]).toEqual([4.85, 52.35])
    expect(screen.getByRole('group', { name: /legend/i })).toHaveTextContent(/solid box/i)
  })

  it('draws a single outline when the form box is the region that was synced', () => {
    render(
      <StationMap
        layer={layer}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    expect(screen.queryByTestId('source-synced')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: /legend/i })).not.toHaveTextContent(/solid box/i)
  })

  it('moves the camera to a region when its stations arrive after the map was already showing', () => {
    const props = {
      property: 'pm25',
      selectedId: null,
      onSelect: vi.fn(),
      now,
      draftBbox: layer.map_layer.bbox,
    }
    const { rerender } = render(<StationMap layer={null} {...props} />)
    expect(mapSpies.fitBounds).not.toHaveBeenCalled()

    rerender(<StationMap layer={layer} {...props} />)

    expect(mapSpies.fitBounds).toHaveBeenCalledTimes(1)
    expect(mapSpies.fitBounds).toHaveBeenCalledWith(
      [4.85, 52.35, 4.95, 52.4],
      expect.objectContaining({
        padding: { top: 48, right: 48, bottom: 120, left: 48 },
        duration: 0,
      }),
    )
  })

  it('moves the camera again for a different region, but not for a re-render of the same one', () => {
    const props = {
      property: 'pm25',
      selectedId: null,
      onSelect: vi.fn(),
      now,
      draftBbox: layer.map_layer.bbox,
    }
    const other = {
      ...layer,
      map_layer: {
        ...layer.map_layer,
        id: 'job-2',
        bbox: [5, 52, 5.1, 52.1] as [number, number, number, number],
      },
    }
    const { rerender } = render(<StationMap layer={layer} {...props} />)
    expect(mapSpies.fitBounds).not.toHaveBeenCalled()

    rerender(<StationMap layer={layer} {...props} property="no2" />)
    expect(mapSpies.fitBounds).not.toHaveBeenCalled()
    rerender(<StationMap layer={other} {...props} />)

    expect(mapSpies.fitBounds).toHaveBeenCalledTimes(1)
    expect(mapSpies.fitBounds).toHaveBeenLastCalledWith([5, 52, 5.1, 52.1], expect.anything())
  })

  it('shows only the visible stations but keeps the colour scale of the whole layer', () => {
    render(
      <StationMap
        layer={layer}
        visibleIds={new Set(['f-1'])}
        property="pm25"
        selectedId={null}
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    expect(stationsSource().features.map((f) => f.properties.value)).toEqual([7.6])
    const legend = screen.getByRole('group', { name: /legend/i })
    expect(legend).toHaveTextContent('7.6')
    expect(legend).toHaveTextContent('36.4')
  })

  it('shows no popup for a selected station the filter has hidden', () => {
    render(
      <StationMap
        layer={layer}
        visibleIds={new Set(['f-1'])}
        property="pm25"
        selectedId="f-2"
        onSelect={vi.fn()}
        now={now}
        draftBbox={layer.map_layer.bbox}
      />,
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('StationMap drawing a region', () => {
  const stop = vi.fn()
  const props = {
    layer: null,
    draftBbox: null,
    property: null,
    selectedId: null,
    onSelect: vi.fn(),
    now,
  }

  beforeEach(() => {
    stop.mockReset()
    vi.mocked(startRectangleDrawing).mockReturnValue(stop)
  })

  it('offers no drawing button when nothing can receive the box', () => {
    render(<StationMap {...props} />)

    expect(screen.queryByRole('button', { name: /draw region/i })).not.toBeInTheDocument()
  })

  it('starts drawing on the map when the button is pressed, and says so', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<StationMap {...props} onBoxDrawn={vi.fn()} />)
    const button = screen.getByRole('button', { name: /draw region/i })
    expect(button).toHaveAttribute('aria-pressed', 'false')

    await user.click(button)

    expect(startRectangleDrawing).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startRectangleDrawing).mock.calls[0]?.[0]).toBe(FAKE_MAP)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/drag on the map/i)).toBeInTheDocument()
  })

  it('hands the drawn box over and leaves drawing mode when the rectangle is finished', async () => {
    const onBoxDrawn = vi.fn()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<StationMap {...props} onBoxDrawn={onBoxDrawn} />)
    await user.click(screen.getByRole('button', { name: /draw region/i }))

    const finish = vi.mocked(startRectangleDrawing).mock.calls[0]?.[1]
    act(() => {
      finish?.([4.85, 52.35, 4.95, 52.4])
    })

    expect(onBoxDrawn).toHaveBeenCalledWith([4.85, 52.35, 4.95, 52.4])
    expect(screen.getByRole('button', { name: /draw region/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(stop).toHaveBeenCalled()
  })

  it('stops drawing when the button is pressed again', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<StationMap {...props} onBoxDrawn={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /draw region/i }))

    await user.click(screen.getByRole('button', { name: /draw region/i }))

    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /draw region/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('cancels with Escape', async () => {
    const onBoxDrawn = vi.fn()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<StationMap {...props} onBoxDrawn={onBoxDrawn} />)
    await user.click(screen.getByRole('button', { name: /draw region/i }))

    await user.keyboard('{Escape}')

    expect(stop).toHaveBeenCalled()
    expect(onBoxDrawn).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /draw region/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('stops drawing when the map goes away', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { unmount } = render(<StationMap {...props} onBoxDrawn={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /draw region/i }))

    unmount()

    expect(stop).toHaveBeenCalled()
  })

  it('ignores clicks on stations while drawing, so a drag cannot select one', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSelect = vi.fn()
    render(<StationMap {...props} onSelect={onSelect} onBoxDrawn={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /draw region/i }))

    await user.click(screen.getByRole('button', { name: 'map: click first station' }))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('announces drawing mode, a finished box and a cancelled drawing in one live region', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<StationMap {...props} onBoxDrawn={vi.fn()} />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('')

    await user.click(screen.getByRole('button', { name: /draw region/i }))
    expect(status).toHaveTextContent(/drawing mode on.*drag on the map/i)

    const finish = vi.mocked(startRectangleDrawing).mock.calls[0]?.[1]
    act(() => {
      finish?.([4.85, 52.35, 4.95, 52.4])
    })
    expect(status).toHaveTextContent(/box drawn/i)

    await user.click(screen.getByRole('button', { name: /draw region/i }))
    await user.keyboard('{Escape}')
    expect(status).toHaveTextContent(/drawing cancelled/i)
  })
})

describe('StationMap view requests', () => {
  const props = {
    layer: null,
    draftBbox: null,
    property: null,
    selectedId: null,
    onSelect: vi.fn(),
    now,
  }

  it('does not move the camera for a request that was already there when the map appeared', () => {
    render(<StationMap {...props} viewRequest={{ bbox: [1, 2, 3, 4], id: 1 }} />)

    expect(mapSpies.fitBounds).not.toHaveBeenCalled()
  })

  it('moves the camera to the box of each new request, and only once per request', () => {
    const { rerender } = render(<StationMap {...props} viewRequest={null} />)

    rerender(<StationMap {...props} viewRequest={{ bbox: [4.7, 52.2, 5.1, 52.4], id: 1 }} />)
    rerender(<StationMap {...props} viewRequest={{ bbox: [4.7, 52.2, 5.1, 52.4], id: 1 }} />)
    expect(mapSpies.fitBounds).toHaveBeenCalledTimes(1)
    expect(mapSpies.fitBounds).toHaveBeenCalledWith(
      [4.7, 52.2, 5.1, 52.4],
      expect.objectContaining({ padding: { top: 48, right: 48, bottom: 120, left: 48 } }),
    )

    rerender(<StationMap {...props} viewRequest={{ bbox: [4.7, 52.2, 5.1, 52.4], id: 2 }} />)
    expect(mapSpies.fitBounds).toHaveBeenCalledTimes(2)
  })
})
