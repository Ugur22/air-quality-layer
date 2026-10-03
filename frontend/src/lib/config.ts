/** Basemap style (ADR 0008): OpenFreeMap needs no API key; override it with VITE_BASEMAP_STYLE_URL. */
export const BASEMAP_STYLE_URL =
  import.meta.env.VITE_BASEMAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty'
