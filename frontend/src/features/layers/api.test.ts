import { afterEach, describe, expect, it, vi } from 'vitest'
import { layer } from '@/test/fixtures'
import { jsonResponse, mockApi } from '@/test/mockApi'
import { getMapLayer } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getMapLayer', () => {
  it('asks for the whole layer when there is no filter', async () => {
    const { calls } = mockApi({ 'GET /api/v1/map-layers/:id': () => jsonResponse(200, layer) })

    await getMapLayer('job-1', null)

    expect(calls[0]?.path).toBe('/api/v1/map-layers/job-1')
    expect(calls[0]?.search).toBe('')
  })

  it('sends property, value and comparator, encoding the comparator', async () => {
    const { calls } = mockApi({ 'GET /api/v1/map-layers/:id': () => jsonResponse(200, layer) })

    await getMapLayer('job-1', { property: 'pm25', comparator: '>=', value: '10.5' })

    const params = new URLSearchParams(calls[0]?.search)
    expect(Object.fromEntries(params)).toEqual({
      property: 'pm25',
      comparator: '>=',
      value: '10.5',
    })
    expect(calls[0]?.search).toContain('%3E%3D')
  })
})
