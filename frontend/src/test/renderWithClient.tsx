import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'

export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrap = (children: ReactElement) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const result = render(wrap(ui))
  const rerender = (next: ReactElement) => {
    result.rerender(wrap(next))
  }
  return { ...result, rerender }
}
