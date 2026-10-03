import {
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatValue } from '@/lib/format'
import { formatAge, isStale } from '@/lib/freshness'
import { median, niceMax, ordinal, rankFromHighest } from '@/lib/stats'
import { ClassChip, GuidelineKey, Swatch } from './GuidelineKey'
import { classOf, guidelineAxisMax, guidelineClasses, valueRange } from './mapData'
import { readingOf } from './stationReadings'
import type { StationFeature } from './types'

/** A strip-plot dot filled with its station's WHO class colour (stored on the point as `fill`). */
function ClassDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: { fill?: string } }) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill={payload?.fill}
      fillOpacity={0.85}
      stroke="var(--color-ink)"
      strokeOpacity={0.6}
    />
  )
}

const AXIS_TICK = { fill: 'var(--color-muted)', fontSize: 11 }

/**
 * What the layer already holds about one station: its value next to the other stations' (a strip
 * plot, since the data is one latest value per station, not a series) and all its readings.
 */
export function StationOverview({
  station,
  stations,
  property,
  now,
}: {
  station: StationFeature
  stations: StationFeature[]
  property: string | null
  now: Date
}) {
  const readings = Object.entries(station.properties.readings).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const range = valueRange(stations, property)
  const own = property === null ? undefined : readingOf(station, property)
  // Only readings in the scale's unit can be compared with each other.
  const comparable =
    range === null || property === null
      ? []
      : stations.flatMap((s) => {
          const r = readingOf(s, property)
          return r?.unit === range.unit
            ? [{ id: s.id, name: s.properties.name, value: r.value }]
            : []
        })
  const unitText = range === null ? '' : range.unit
  const inScale =
    property !== null && own !== undefined && range !== null && own.unit === range.unit
  const values = comparable.map((c) => c.value)
  const mid = median(values)
  const rank = inScale ? rankFromHighest(values, own.value) : null
  const classes = range === null ? null : guidelineClasses(property, range.unit)
  const others = comparable
    .filter((c) => c.id !== station.id)
    .map((c, i) => ({ ...c, lane: i % 3, fill: classOf(classes, c.value)?.colour }))
  const ownClass = own === undefined ? undefined : classOf(classes, own.value)
  const dataMax = niceMax(Math.max(...values, 0))
  const axisMax = classes === null ? dataMax : guidelineAxisMax(classes, dataMax)

  return (
    <div className="flex flex-col gap-6">
      {property !== null && own ? (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <span className="font-display text-5xl font-bold leading-none tracking-tight tabular-nums">
            {formatValue(own.value)}
          </span>
          <span className="pb-1 text-sm text-muted">
            {own.unit} <span className="font-mono">{property}</span>
            {ownClass ? (
              <span className="mt-0.5 block">
                <ClassChip guideline={ownClass} unit="" />
                <span className="sr-only"> WHO 2021 24-hour guideline class</span>
              </span>
            ) : null}
          </span>
          <span className="ml-auto pb-1 text-right text-sm text-muted">
            {rank !== null ? (
              <>
                <strong className="block font-semibold text-ink">{ordinal(rank)} highest</strong>
                of {String(values.length)} {values.length === 1 ? 'station' : 'stations'} in this
                region
              </>
            ) : (
              'Reported in a different unit, so not compared'
            )}
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted">
          {property === null
            ? 'This layer has no pollutant to compare.'
            : `This station reports no ${property}.`}
        </p>
      )}

      {inScale && mid !== null ? (
        <section aria-label="Position among stations" className="flex flex-col gap-1">
          <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Where this station sits · {property} across the region
          </h3>
          <p className="sr-only">
            {`${property} here is ${formatValue(own.value)} ${own.unit}, ${ordinal(rank ?? 1)} highest of ${String(values.length)}. The median is ${formatValue(mid)}.${ownClass ? ` WHO 2021 guideline class ${ownClass.label} ${own.unit}.` : ''}`}
          </p>
          <div className="h-40 w-full" aria-hidden>
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 760, height: 160 }}
            >
              <ScatterChart
                accessibilityLayer={false}
                margin={{ top: 22, right: 14, bottom: 0, left: 14 }}
              >
                <XAxis
                  type="number"
                  dataKey="value"
                  domain={[0, axisMax]}
                  ticks={[0, 0.25, 0.5, 0.75, 1].map((f) => f * axisMax)}
                  tickFormatter={(v: number) => formatValue(v)}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--color-line)' }}
                />
                <YAxis type="number" dataKey="lane" domain={[-0.6, 2.6]} hide />
                {classes
                  ?.filter((c) => c.from < axisMax)
                  .map((c) => (
                    <ReferenceArea
                      key={c.label}
                      x1={c.from}
                      x2={Math.min(c.upTo, axisMax)}
                      fill={c.colour}
                      fillOpacity={0.25}
                      stroke="none"
                      ifOverflow="hidden"
                    />
                  ))}
                <ReferenceLine
                  x={mid}
                  stroke="var(--color-muted)"
                  strokeDasharray="4 3"
                  label={{
                    value: `median ${formatValue(mid)}`,
                    position: 'top',
                    fill: 'var(--color-muted)',
                    fontSize: 11,
                  }}
                />
                <Tooltip
                  cursor={false}
                  content={({ payload }) => {
                    const item = payload[0]?.payload as
                      { name?: string; value?: number } | undefined
                    return item?.name === undefined || item.value === undefined ? null : (
                      <div className="rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-sm">
                        <strong>{item.name}</strong> {formatValue(item.value)} {unitText}
                      </div>
                    )
                  }}
                />
                <Scatter
                  data={others}
                  fill="var(--color-accent)"
                  fillOpacity={classes === null ? 0.45 : 0.85}
                  stroke={classes === null ? undefined : 'var(--color-ink)'}
                  strokeOpacity={0.6}
                  isAnimationActive={false}
                  shape={classes === null ? 'circle' : ClassDot}
                />
                <Scatter
                  data={[{ name: station.properties.name, value: own.value, lane: 1 }]}
                  fill={ownClass?.colour ?? 'var(--color-accent)'}
                  stroke="var(--color-ink)"
                  strokeWidth={2.5}
                  shape="circle"
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          {classes !== null ? (
            <GuidelineKey
              classes={classes}
              unit={own.unit}
              note="Each dot is a station's latest reading. The bands are 24-hour levels, so one high hourly reading does not mean the day exceeds them."
            />
          ) : null}
        </section>
      ) : null}

      <section aria-label="All readings" className="flex flex-col gap-1.5">
        <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          All readings
        </h3>
        {readings.length === 0 ? (
          <p className="text-sm text-muted">No readings reported by this station.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {readings.map(([name, reading]) => {
              const peak = Math.max(
                ...stations.flatMap((s) => {
                  const r = readingOf(s, name)
                  return r?.unit === reading.unit ? [r.value] : []
                }),
                0,
              )
              const rowClasses = guidelineClasses(name, reading.unit)
              const rowClass = classOf(rowClasses, reading.value)
              // With a guideline the bar is absolute (full means above the top class); without
              // one it can only be relative to the other stations.
              const topBound = rowClasses?.[rowClasses.length - 2]?.upTo
              const scaleTo = topBound ?? peak
              const share = scaleTo > 0 ? Math.max(0, Math.min(1, reading.value / scaleTo)) : 0
              const current = name === property
              return (
                <li
                  key={name}
                  aria-current={current ? 'true' : undefined}
                  className="grid grid-cols-[minmax(4rem,8rem)_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm aria-[current=true]:bg-accent-soft"
                >
                  <span className="truncate font-mono text-xs" title={name}>
                    {name}
                  </span>
                  <span aria-hidden className="h-2 overflow-hidden rounded-full bg-line">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{
                        width: `${String(share * 100)}%`,
                        ...(rowClass ? { background: rowClass.colour } : {}),
                      }}
                    />
                  </span>
                  <span className="text-right tabular-nums">
                    <strong className="font-semibold">{formatValue(reading.value)}</strong>{' '}
                    <span className="text-xs text-muted">
                      {reading.unit} · {formatAge(reading.observed_at, now)}
                    </span>
                    {rowClass ? (
                      <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-xs text-muted">
                        <Swatch colour={rowClass.colour} />
                        {rowClass.label}
                      </span>
                    ) : null}
                    {isStale(reading.observed_at, now) ? (
                      <span className="ml-1.5 rounded-full border border-warn/50 px-1.5 font-mono text-xs text-warn">
                        stale
                      </span>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
