import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse, mockApi } from '@/test/mockApi'
import { searchPlaces } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchPlaces', () => {
  it('sends the text as one encoded q parameter, however odd it is', async () => {
    const { calls } = mockApi({ 'GET /api/v1/places': () => jsonResponse(200, { places: [] }) })

    await searchPlaces('Zürich & co=1&limit=999')

    expect(calls[0]?.path).toBe('/api/v1/places')
    const params = new URLSearchParams(calls[0]?.search)
    expect([...params.keys()]).toEqual(['q'])
    expect(params.get('q')).toBe('Zürich & co=1&limit=999')
  })

  it('returns the places', async () => {
    mockApi({
      'GET /api/v1/places': () =>
        jsonResponse(200, {
          places: [{ id: 'R1', name: 'A', detail: '', kind: 'city', point: [1, 2], bbox: null }],
        }),
    })

    expect(await searchPlaces('abc')).toEqual([
      { id: 'R1', name: 'A', detail: '', kind: 'city', point: [1, 2], bbox: null },
    ])
  })
})
