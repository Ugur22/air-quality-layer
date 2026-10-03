import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('BASEMAP_STYLE_URL', () => {
  it('defaults to OpenFreeMap, which needs no key', async () => {
    vi.stubEnv('VITE_BASEMAP_STYLE_URL', undefined)
    const { BASEMAP_STYLE_URL } = await import('./config')

    expect(BASEMAP_STYLE_URL).toBe('https://tiles.openfreemap.org/styles/liberty')
  })

  it('uses the configured style', async () => {
    vi.stubEnv('VITE_BASEMAP_STYLE_URL', 'https://example.test/style.json')
    const { BASEMAP_STYLE_URL } = await import('./config')

    expect(BASEMAP_STYLE_URL).toBe('https://example.test/style.json')
  })

  it('treats an empty value as not set, not as an empty style', async () => {
    vi.stubEnv('VITE_BASEMAP_STYLE_URL', '')
    const { BASEMAP_STYLE_URL } = await import('./config')

    expect(BASEMAP_STYLE_URL).toBe('https://tiles.openfreemap.org/styles/liberty')
  })
})
