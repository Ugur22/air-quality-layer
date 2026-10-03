import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiError, jsonResponse, mockApi } from '@/test/mockApi'
import { ApiError, apiFetch } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiFetch', () => {
  it('returns the parsed body of a successful response', async () => {
    mockApi({ 'GET /api/v1/things': () => jsonResponse(200, { ok: true }) })

    await expect(apiFetch('/things')).resolves.toEqual({ ok: true })
  })

  it('sends a JSON body with a content type', async () => {
    const { calls } = mockApi({ 'POST /api/v1/things': () => jsonResponse(201, {}) })

    await apiFetch('/things', { method: 'POST', body: { name: 'x' } })

    expect(calls[0]?.body).toEqual({ name: 'x' })
  })

  it('turns the API error envelope into an ApiError with its code', async () => {
    mockApi({ 'GET /api/v1/things': () => apiError(409, 'conflict', 'A sync is already running.') })

    const error = await apiFetch('/things').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'A sync is already running.',
    })
  })

  it('uses a generic code when an error response is not the API envelope', async () => {
    mockApi({
      'GET /api/v1/things': () => new Response('<html>Bad gateway</html>', { status: 502 }),
    })

    const error = await apiFetch('/things').catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 502, code: 'unknown_error' })
  })

  it('reports an unreachable server as network_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    const error = await apiFetch('/things').catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 0, code: 'network_error' })
  })

  it('treats a successful response with a non-JSON body as an error', async () => {
    mockApi({ 'GET /api/v1/things': () => new Response('not json', { status: 200 }) })

    const error = await apiFetch('/things').catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'unknown_error' })
  })
})
