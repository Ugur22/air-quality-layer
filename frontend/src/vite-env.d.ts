/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** MapLibre style URL for the basemap (ADR 0008); defaults to OpenFreeMap's hosted style. */
  readonly VITE_BASEMAP_STYLE_URL?: string
}
