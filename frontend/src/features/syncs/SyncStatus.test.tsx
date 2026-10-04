import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { succeededJob, syncJob } from '@/test/fixtures'
import { SyncStatus } from './SyncStatus'

describe('SyncStatus', () => {
  it('says a queued sync is waiting', () => {
    render(<SyncStatus job={syncJob({ status: 'queued' })} />)

    expect(screen.getByRole('status')).toHaveTextContent(/waiting/i)
  })

  it('says a processing sync is fetching', () => {
    render(<SyncStatus job={syncJob({ status: 'processing' })} />)

    expect(screen.getByRole('status')).toHaveTextContent(/fetching stations/i)
  })

  it('shows the station count when the sync succeeded', () => {
    render(<SyncStatus job={succeededJob} />)

    expect(screen.getByRole('status')).toHaveTextContent('12 stations')
  })

  it('says when a succeeded sync is missing a source, instead of staying silent', () => {
    const warnings = [{ code: 'luchtmeetnet_unavailable', message: 'server words' }]
    render(<SyncStatus job={{ ...succeededJob, warnings }} />)

    expect(screen.getByRole('status')).toHaveTextContent('12 stations')
    expect(screen.getByRole('status')).toHaveTextContent(/luchtmeetnet could not be used/i)
  })

  it('falls back to the server message for a warning it does not know', () => {
    render(
      <SyncStatus
        job={{ ...succeededJob, warnings: [{ code: 'new_thing', message: 'Heads up.' }] }}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Heads up.')
  })

  it('shows a warning code that matches an object property as the server message', () => {
    render(
      <SyncStatus
        job={{ ...succeededJob, warnings: [{ code: 'constructor', message: 'Server words.' }] }}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Server words.')
  })

  it('uses the singular for one station', () => {
    render(<SyncStatus job={{ ...succeededJob, station_count: 1 }} />)

    expect(screen.getByRole('status')).toHaveTextContent('1 station')
    expect(screen.getByRole('status')).not.toHaveTextContent('1 stations')
  })

  it('treats zero stations as a valid outcome, not an error', () => {
    render(<SyncStatus job={{ ...succeededJob, station_count: 0 }} />)

    expect(screen.getByRole('status')).toHaveTextContent(/no stations/i)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['upstream_unavailable', /could not be reached/i],
    ['upstream_unauthorized', /rejected the server/i],
    ['upstream_invalid_response', /unexpected shape/i],
    ['too_many_stations', /more than 50 stations/i],
    ['timed_out', /took too long/i],
    ['processing_error', /went wrong on the server/i],
  ])('explains the failure code %s in words', (code, text) => {
    render(<SyncStatus job={syncJob({ status: 'failed', errors: [{ code, message: 'raw' }] })} />)

    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('falls back to the server message for a failure code it does not know', () => {
    render(
      <SyncStatus
        job={syncJob({
          status: 'failed',
          errors: [{ code: 'brand_new', message: 'Something new.' }],
        })}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Something new.')
  })

  it('still renders a failed sync that carries no error entries', () => {
    render(<SyncStatus job={syncJob({ status: 'failed', errors: [] })} />)

    expect(screen.getByRole('alert')).toHaveTextContent(/failed/i)
  })

  it('renders a status it does not know instead of crashing', () => {
    render(<SyncStatus job={syncJob({ status: 'paused' })} />)

    expect(screen.getByRole('status')).toHaveTextContent('paused')
  })
})
