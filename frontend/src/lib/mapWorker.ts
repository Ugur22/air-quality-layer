import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

// MapLibre 6 locates its web worker with a URL the bundler cannot see, so `vite build` would not
// emit it ("Worker failed to load"). Importing it through Vite gives it a real, hashed URL.
// Imported once from main.tsx, not from the map component, so unit tests never load MapLibre.
setWorkerUrl(workerUrl)
