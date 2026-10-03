import { vi } from 'vitest'

/** Calls the app makes on the real map instance, for tests to assert on. */
export const mapSpies = { fitBounds: vi.fn() }

/** What `getMap()` returns in tests: the app only passes it on to the drawing library. */
export const FAKE_MAP = { fake: 'maplibre-map' }
