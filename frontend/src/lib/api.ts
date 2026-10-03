const BASE = '/api/v1'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface Options {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
}

function errorEnvelope(body: unknown): { code: string; message: string } | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null
  const error = body.error
  if (typeof error !== 'object' || error === null) return null
  if (!('code' in error) || typeof error.code !== 'string') return null
  if (!('message' in error) || typeof error.message !== 'string') return null
  return { code: error.code, message: error.message }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * The only place the browser talks to the backend (the OpenAQ key and OpenAQ itself never reach
 * it). Failures become ApiError carrying the contract's stable `code`; callers branch on that,
 * never on the message.
 */
export async function apiFetch<T>(path: string, options: Options = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, 'network_error', 'Could not reach the server. Is the backend running?')
  }

  const body = parseJson(await response.text())
  if (!response.ok) {
    const envelope = errorEnvelope(body)
    if (envelope) throw new ApiError(response.status, envelope.code, envelope.message)
    throw new ApiError(
      response.status,
      'unknown_error',
      `The server answered ${String(response.status)}.`,
    )
  }
  if (body === undefined) {
    throw new ApiError(response.status, 'unknown_error', 'The server sent an unreadable response.')
  }
  return body as T
}
