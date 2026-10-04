import { vi } from 'vitest'

/** Calls the app makes on the real map instance, for tests to assert on. */
export const mapSpies = { fitBounds: vi.fn(), easeTo: vi.fn(), addImage: vi.fn(), holdLoad: false }

/** What `getMap()` returns in tests: the app passes it on to the drawing library and registers the badge image on it. */
export const FAKE_MAP = {
  fake: 'maplibre-map',
  hasImage: () => false,
  addImage: mapSpies.addImage,
}
