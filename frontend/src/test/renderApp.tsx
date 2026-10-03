import App from '@/App'
import { renderWithClient } from './renderWithClient'

export function renderApp() {
  return renderWithClient(<App />)
}
