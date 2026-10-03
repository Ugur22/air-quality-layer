/**
 * Basemap style (ADR 0008): OpenFreeMap needs no API key; override it with VITE_BASEMAP_STYLE_URL.
 * The station value labels need the style to define `glyphs` and the 'Noto Sans Bold' fontstack;
 * without them the labels do not draw (the markers still do).
 */
export const BASEMAP_STYLE_URL =
  import.meta.env.VITE_BASEMAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty'
