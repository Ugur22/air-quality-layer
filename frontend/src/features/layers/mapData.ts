import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl'
import { formatValue } from '@/lib/format'
import { isStale } from '@/lib/freshness'
import type { StationFeature } from './types'

export interface MapStationProperties {
  id: string
  name: string
  hasValue: boolean
  value: number | null
  /** The number written in the badge; empty when there is no value, as that station has no badge. */
  label: string
  stale: boolean
}

export interface MapStationCollection {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: MapStationProperties
  }[]
}

export interface ValueRange {
  min: number
  max: number
  unit: string
  /** Stations reporting this parameter in a different unit; they are left off the scale. */
  otherUnitCount: number
}

/** pm25 is the most commonly reported pollutant; otherwise the first one the layer has. */
export function pickColourProperty(propertyKeys: string[]): string | null {
  if (propertyKeys.includes('pm25')) return 'pm25'
  return propertyKeys[0] ?? null
}

/**
 * One flat record per station for the chosen property. Map styles read feature properties as flat
 * values, so the nested `readings` object cannot be styled directly. Staleness is that reading's
 * own age: a station can be current for one pollutant and months old for another.
 */
export function buildMapData(
  stations: StationFeature[],
  property: string | null,
  now: Date,
  /** The stations the colour scale (and its unit) is taken from; the whole layer when filtering. */
  scaleFrom: StationFeature[] = stations,
): MapStationCollection {
  const unit = valueRange(scaleFrom, property)?.unit
  return {
    type: 'FeatureCollection',
    features: stations.map((station) => {
      const found = property === null ? undefined : station.properties.readings[property]
      // A reading in another unit cannot share this colour scale, so it is drawn as a grey dot.
      const reading = found?.unit === unit ? found : undefined
      return {
        type: 'Feature',
        geometry: station.geometry,
        properties: {
          id: station.id,
          name: station.properties.name,
          hasValue: reading !== undefined,
          value: reading?.value ?? null,
          label: reading === undefined ? '' : formatValue(reading.value),
          stale: reading !== undefined && isStale(reading.observed_at, now),
        },
      }
    }),
  }
}

/** The scale uses the most common unit for the parameter (ties go to the unit seen first). */
export function valueRange(stations: StationFeature[], property: string | null): ValueRange | null {
  if (property === null) return null
  const readings = stations.flatMap((s) => {
    const reading = s.properties.readings[property]
    return reading ? [reading] : []
  })
  const counts = new Map<string, number>()
  for (const r of readings) counts.set(r.unit, (counts.get(r.unit) ?? 0) + 1)
  let unit: string | undefined
  for (const [candidate, count] of counts) {
    if (unit === undefined || count > (counts.get(unit) ?? 0)) unit = candidate
  }
  if (unit === undefined) return null
  const values = readings.filter((r) => r.unit === unit).map((r) => r.value)
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    unit,
    otherUnitCount: readings.length - values.length,
  }
}

/** Low to high on one hue. The scale is relative to this layer; it is not an air-quality index. */
export const COLOUR_STOPS = ['#cfe8e4', '#2f9c93', '#07403d'] as const

/** ColorBrewer YlOrRd, 5 classes: hue escalates, so the top class cannot read as benign. */
export const GUIDELINE_COLOURS = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'] as const

/**
 * Upper bounds (inclusive) of each class below the last, in µg/m³: the WHO 2021 24-hour guideline
 * level, then interim targets. To fit five colours one target is left out (pm25: 37.5, pm10: 50),
 * so a class position is not the same interim target across pollutants (ADR 0015). The stored value
 * is the latest hourly reading, so a class describes that reading, not a 24-hour mean.
 */
const GUIDELINE_BREAKS: Record<string, readonly number[]> = {
  pm25: [15, 25, 50, 75],
  pm10: [45, 75, 100, 150],
  no2: [25, 50, 120],
}

export interface GuidelineClass {
  colour: string
  label: string
  /** Exclusive lower bound of the class; 0 for the first. */
  from: number
  /** Inclusive upper bound of the class; Infinity for the last. */
  upTo: number
}

/** OpenAQ spells the unit with either the micro sign or the Greek mu. */
const isMicrogramsPerCubicMetre = (unit: string) => unit.replace('μ', 'µ') === 'µg/m³'

/** Fewer classes than colours skip the second-to-last step, so the top class stays the darkest. */
function coloursFor(count: number): string[] {
  const [darkest] = GUIDELINE_COLOURS.slice(-1)
  return count >= GUIDELINE_COLOURS.length
    ? [...GUIDELINE_COLOURS]
    : [...GUIDELINE_COLOURS.slice(0, count - 1), darkest ?? NO_FILL]
}

/** The classes for a pollutant, or null when there is no table or the unit is not µg/m³. */
export function guidelineClasses(property: string | null, unit: string): GuidelineClass[] | null {
  const breaks = property === null ? undefined : GUIDELINE_BREAKS[property]
  if (breaks === undefined || !isMicrogramsPerCubicMetre(unit)) return null
  const colours = coloursFor(breaks.length + 1)
  return [...breaks, Infinity].map((upTo, i) => {
    const lower = breaks[i - 1]
    const label =
      lower === undefined
        ? `≤ ${formatValue(upTo)}`
        : upTo === Infinity
          ? `> ${formatValue(lower)}`
          : `${formatValue(lower)}–${formatValue(upTo)}`
    return { colour: colours[i] ?? '', label, from: lower ?? 0, upTo }
  })
}

/** The class a value falls in; a value on a boundary belongs to the lower class, as on the map. */
export function classOf(
  classes: GuidelineClass[] | null,
  value: number,
): GuidelineClass | undefined {
  return classes?.find((c) => value <= c.upTo)
}

/** Room for the guideline level and the class above it, so the first bands are always visible. */
export function guidelineAxisMax(classes: GuidelineClass[], dataMax: number): number {
  return Math.max(dataMax, (classes[0]?.upTo ?? 0) * 2)
}

const NO_FILL = 'rgba(0, 0, 0, 0)'

function guidelineFill(property: string, unit: string) {
  const classes = guidelineClasses(property, unit)
  if (classes === null) return null
  const last = classes[classes.length - 1]
  // `case` with `<=` keeps a value exactly on a boundary in the lower class; `step` would not.
  const branches = classes.slice(0, -1).flatMap((c) => [['<=', ['get', 'value'], c.upTo], c.colour])
  return ['case', ...branches, last === undefined ? NO_FILL : last.colour]
}

/** The fill colour of a station with a value: its WHO class, or the layer-relative ramp. */
export function stationFill(
  range: ValueRange | null,
  property: string | null = null,
): ExpressionSpecification | string {
  const [low, mid, high] = COLOUR_STOPS
  // Interpolation stops must strictly ascend. A range one float step wide would make the middle
  // stop equal to an end and invalidate the whole layer, so it counts as a single value.
  const middle = range === null ? 0 : (range.min + range.max) / 2
  const hasSpread = range !== null && range.min < middle && middle < range.max
  const classed = range === null || property === null ? null : guidelineFill(property, range.unit)
  return (
    (classed as ExpressionSpecification | null) ??
    (hasSpread
      ? ([
          'interpolate',
          ['linear'],
          ['get', 'value'],
          range.min,
          low,
          middle,
          mid,
          range.max,
          high,
        ] as ExpressionSpecification)
      : mid)
  )
}

const INK = '#12201f'

/**
 * Text on the darkest fill is white; everywhere else the dark ink reads better. Classes are cut at
 * the last break, ramps where the teal gets dark enough for white (a ramp without spread is one
 * mid-teal).
 */
function badgeTextColour(range: ValueRange | null, property: string | null) {
  const classes = range === null ? null : guidelineClasses(property, range.unit)
  const darkFrom =
    classes !== null
      ? classes.at(-2)?.upTo
      : range !== null && range.min < range.max
        ? range.min + (range.max - range.min) * 0.65
        : undefined
  return darkFrom === undefined ? INK : ['case', ['>', ['get', 'value'], darkFrom], '#ffffff', INK]
}

/** Image registered on the map at load (see badgeImage.ts); stations with a value draw it. */
export const BADGE_IMAGE = 'station-badge'
/** The hollow badge of a stale reading, one image per class colour (see badgeImage.ts). */
export const staleBadgeImage = (colour: string) => `station-badge-stale-${colour.slice(1)}`
const STALE: ExpressionSpecification = ['get', 'stale']
export const HAS_VALUE_FILTER: ExpressionSpecification = ['get', 'hasValue']
export const NO_VALUE_FILTER: ExpressionSpecification = ['!', HAS_VALUE_FILTER]

/**
 * Badges do not overlap: where two collide, the one with the higher value keeps its place (symbols
 * with a lower sort key are placed first) and the other is left to its dot underneath until the
 * map is zoomed in. The map's own labels yield to the badges, not the other way round.
 */
export const STATION_BADGE_LAYOUT = {
  'icon-image': BADGE_IMAGE,
  'icon-text-fit': 'both',
  'icon-text-fit-padding': [1, 5, 1, 5],
  'icon-allow-overlap': false,
  'text-field': ['get', 'label'],
  'text-font': ['Noto Sans Bold'],
  'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9.5, 14, 12],
  'text-allow-overlap': false,
  'symbol-sort-key': ['*', -1, ['get', 'value']],
} as SymbolLayerSpecification['layout']

/**
 * With a class table, stale readings are drawn by their own layer (see staleBadgeLayer). MapLibre
 * cannot mix SDF and non-SDF icons in one layer's buffer, so the SDF pill layer leaves them out.
 * Without a table a stale reading stays here, drawn as the white SDF pill outlined in its ramp
 * colour (see stationBadgePaint).
 */
export function stationBadgeFilter(
  range: ValueRange | null,
  property: string | null = null,
): ExpressionSpecification {
  const classed = range !== null && guidelineClasses(property, range.unit) !== null
  return classed ? ['all', HAS_VALUE_FILTER, ['!', STALE]] : HAS_VALUE_FILTER
}

/**
 * The hollow badge of a stale reading: a full-colour image per class colour (badgeImage.ts), so it
 * is a layer of its own. Null where the pollutant has no class table.
 */
export function staleBadgeLayer(range: ValueRange | null, property: string | null = null) {
  const classes = range === null ? null : guidelineClasses(property, range.unit)
  const last = classes?.at(-1)
  if (classes === null || last === undefined) return null
  return {
    filter: ['all', HAS_VALUE_FILTER, STALE] as ExpressionSpecification,
    layout: {
      ...STATION_BADGE_LAYOUT,
      'icon-image': [
        'case',
        ...classes
          .slice(0, -1)
          .flatMap((c) => [['<=', ['get', 'value'], c.upTo], staleBadgeImage(c.colour)]),
        staleBadgeImage(last.colour),
      ],
    } as SymbolLayerSpecification['layout'],
    // The badge is white inside, so its number is always dark.
    paint: { 'text-color': INK } as SymbolLayerSpecification['paint'],
  }
}

export function stationBadgePaint(
  range: ValueRange | null,
  property: string | null = null,
): SymbolLayerSpecification['paint'] {
  return {
    // The border is the SDF halo of the same pill, so it is placed or dropped with it. The stale
    // cases only apply to a ramp reading (a classed one is in staleBadgeLayer): white inside, the
    // ramp colour as the outline.
    'icon-color': ['case', STALE, '#ffffff', stationFill(range, property)],
    'icon-halo-color': ['case', STALE, stationFill(range, property), INK],
    'icon-halo-width': ['case', STALE, 3, 1.5],
    // A stale ramp reading is white inside, so its number is dark.
    'text-color': ['case', STALE, INK, badgeTextColour(range, property)],
  } as SymbolLayerSpecification['paint']
}

/**
 * Every station with a value has a dot, drawn under the badges: a station whose badge lost a
 * collision is still on the map, hoverable and clickable. The highest value is on top.
 */
export const STATION_DOT_LAYOUT = {
  'circle-sort-key': ['get', 'value'],
} as CircleLayerSpecification['layout']

export function stationDotPaint(
  range: ValueRange | null,
  property: string | null = null,
): CircleLayerSpecification['paint'] {
  return {
    'circle-radius': 6,
    // A stale dot is hollow like its badge: white inside, a ring in the class colour.
    'circle-color': ['case', STALE, '#ffffff', stationFill(range, property)],
    'circle-stroke-width': ['case', STALE, 3, 1.5],
    'circle-stroke-color': ['case', STALE, stationFill(range, property), INK],
  }
}

/** The ink edge of a stale dot: its class-coloured ring is too pale on the basemap to hold the dot. */
export const STALE_DOT_FILTER: ExpressionSpecification = ['all', HAS_VALUE_FILTER, STALE]
export const STATION_DOT_EDGE_PAINT = {
  // A stale dot's ring reaches 6 + 3 px, so the edge has to reach past it to show.
  'circle-radius': 10,
  'circle-color': INK,
} as CircleLayerSpecification['paint']

const SELECTED_STROKE = {
  'circle-color': 'rgba(0, 0, 0, 0)',
  'circle-stroke-width': 3,
  'circle-stroke-color': '#0a7570',
}

/** Ring around the selected station: wide enough to clear its badge, and shown with or without it. */
export const STATION_SELECTED_PAINT = {
  ...SELECTED_STROKE,
  'circle-radius': 15,
} as CircleLayerSpecification['paint']

/**
 * A station without a usable value is a small grey dot with no number: it stays visible and
 * clickable but does not compete with the readings.
 */
export const STATION_EMPTY_PAINT = {
  'circle-radius': 4.5,
  'circle-color': '#b4c0be',
  'circle-stroke-width': 1.5,
  'circle-stroke-color': '#4d6360',
} as CircleLayerSpecification['paint']

export const STATION_EMPTY_SELECTED_PAINT = {
  ...SELECTED_STROKE,
  'circle-radius': 9,
} as CircleLayerSpecification['paint']
