import { ApiError } from '@/lib/api'

const SYNC_FAILURES: Record<string, string> = {
  upstream_unavailable:
    'OpenAQ could not be reached or kept failing. Nothing was stored; try again in a few minutes.',
  upstream_unauthorized:
    "OpenAQ rejected the server's API key. Check the key configured for the backend.",
  upstream_invalid_response: 'OpenAQ sent data in an unexpected shape, so nothing was stored.',
  too_many_stations: 'This region contains more than 50 stations. Choose a smaller region.',
  timed_out: 'The sync took too long and was stopped. Try again.',
  processing_error: 'Something went wrong on the server. Try again.',
}

/** Words for a sync failure code; an unknown code falls back to the server's own message. */
export function describeSyncFailure(code: string, serverMessage: string): string {
  return SYNC_FAILURES[code] ?? serverMessage
}

const SYNC_WARNINGS: Record<string, string> = {
  luchtmeetnet_unavailable:
    'Luchtmeetnet could not be used, so these stations come from OpenAQ only.',
}

/** Words for a warning on a succeeded sync; an unknown code falls back to the server's message. */
export function describeSyncWarning(code: string, serverMessage: string): string {
  // hasOwn: a code such as "constructor" must not find something on the object's prototype.
  return Object.hasOwn(SYNC_WARNINGS, code) ? (SYNC_WARNINGS[code] ?? serverMessage) : serverMessage
}

const REQUEST_FAILURES: Record<string, string> = {
  network_error: 'Could not reach the server. Is the backend running?',
  conflict: 'A sync is already running for this region. Wait for it to finish.',
  service_unavailable: 'The sync could not be queued. Try again shortly.',
  not_found: 'That was not found. It may belong to a different organisation.',
}

/** Words for a failed request, by the contract's stable error code. */
export function describeRequestFailure(code: string, serverMessage: string): string {
  return REQUEST_FAILURES[code] ?? serverMessage
}

/** Words for any failure from the API client; anything else is an unexpected error. */
export function describeError(error: unknown): string {
  return error instanceof ApiError
    ? describeRequestFailure(error.code, error.message)
    : 'Something went wrong. Try again.'
}
