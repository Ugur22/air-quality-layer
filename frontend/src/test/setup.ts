import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { useSession } from '@/stores/session'

// jsdom has no layout engine; cmdk (the combobox) expects these two browser features to exist.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub
Element.prototype.scrollIntoView = () => {}

// Testing Library only auto-registers cleanup when test globals are enabled; we import explicitly.
afterEach(cleanup)

// The store is a module-level singleton; no test may inherit another test's region, draft or selection.
afterEach(() => {
  useSession.setState(useSession.getInitialState())
})
