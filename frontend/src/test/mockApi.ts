import { vi } from 'vitest'

export interface RecordedCall {
  method: string
  path: string
  search: string
  body: unknown
}

type Handler = (call: RecordedCall) => Response | Promise<Response>

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function apiError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message, details: [] } })
}

function toMatcher(route: string): { method: string; pattern: RegExp } {
  const [method = '', path = ''] = route.split(' ')
  const pattern = new RegExp(`^${path.replace(/:[a-z_]+/g, '[^/]+')}$`)
  return { method, pattern }
}

/**
 * Replaces `fetch` with a router keyed by "METHOD /path" (`:id` matches one segment). A request
 * with no matching route fails the test loudly instead of silently returning nothing.
 */
export function mockApi(routes: Record<string, Handler>): { calls: RecordedCall[] } {
  const matchers = Object.entries(routes).map(([route, handler]) => ({
    ...toMatcher(route),
    handler,
  }))
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost')
      const method = init?.method ?? 'GET'
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      const call = { method, path: url.pathname, search: url.search, body }
      calls.push(call)
      const match = matchers.find((m) => m.method === method && m.pattern.test(url.pathname))
      if (!match) throw new Error(`Unmocked request: ${method} ${url.pathname}`)
      return match.handler(call)
    }),
  )
  return { calls }
}
