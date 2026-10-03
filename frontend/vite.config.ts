import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    // Proxying keeps the browser on one origin, so the API needs no CORS configuration.
    // 8001 is the AirLayer API in compose.yaml; override with AIRLAYER_API_URL if it moves.
    proxy: { '/api': process.env.AIRLAYER_API_URL ?? 'http://127.0.0.1:8001' },
  },
  test: {
    // Browser tests (Playwright) are run by `make e2e`, not by Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
