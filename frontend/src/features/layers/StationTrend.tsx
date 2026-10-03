import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { formatValue } from '@/lib/format'
import { describeError } from '@/features/syncs/messages'
import { ApiError } from '@/lib/api'
import { niceMax } from '@/lib/stats'
import { HISTORY_HOURS, useStationHistory } from './api'
import { ClassChip, GuidelineKey } from './GuidelineKey'
import { classOf, guidelineAxisMax, guidelineClasses } from './mapData'

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const DAY_TIME = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** The server words an unavailable trend itself; describeError's text for this code is about syncs. */
function describeHistoryError(error: unknown): string {
  return error instanceof ApiError && error.code === 'service_unavailable'
    ? error.message
    : describeError(error)
}

const AXIS_TICK = { fill: 'var(--color-muted)', fontSize: 11 }

/**
 * The last hours of one pollutant at one station (ADR 0014). It is only asked for once this is
 * shown (`active`), because the server fetches it from OpenAQ and every miss spends rate limit.
 */
export function StationTrend({
  layerId,
  stationId,
  property,
  active,
}: {
  layerId: string
  stationId: string
  property: string | null
  active: boolean
}) {
  const history = useStationHistory(layerId, stationId, property, active)

  if (property === null) {
    return <p className="text-sm text-muted">This layer has no pollutant to chart.</p>
  }
  if (history.isPending) {
    return (
      <p role="status" className="text-sm text-muted">
        Loading the last {HISTORY_HOURS} hours…
      </p>
    )
  }
  if (history.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert variant="destructive">
          <AlertDescription>{describeHistoryError(history.error)}</AlertDescription>
        </Alert>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void history.refetch()
          }}
        >
          Try again
        </Button>
      </div>
    )
  }

  const { points, unit } = history.data
  if (points.length === 0) {
    return (
      <p className="text-sm text-muted">
        {unit === null
          ? `This station has no ${property} sensor.`
          : `No ${property} readings in the last ${String(HISTORY_HOURS)} hours. The station may have stopped reporting.`}
      </p>
    )
  }

  const data = points.map((p) => ({ t: new Date(p.at).getTime(), value: p.value }))
  const values = data.map((d) => d.value)
  const latest = data[data.length - 1] as (typeof data)[number]
  const low = Math.min(...values)
  const high = Math.max(...values)
  const unitText = unit ?? ''
  const classes = guidelineClasses(property, unitText)
  const latestClass = classOf(classes, latest.value)
  const axisTop = classes === null ? undefined : guidelineAxisMax(classes, niceMax(high))
  const bands =
    classes === null || axisTop === undefined ? [] : classes.filter((c) => c.from < axisTop)

  return (
    <div className="flex flex-col gap-4">
      <div
        className="h-80 w-full"
        role="img"
        aria-label={`${property} over the last ${String(HISTORY_HOURS)} hours: latest ${formatValue(latest.value)} ${unitText}${latestClass ? ` (WHO class ${latestClass.label})` : ''}, lowest ${formatValue(low)}, highest ${formatValue(high)}`}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 760, height: 320 }}
        >
          <AreaChart
            accessibilityLayer={false}
            data={data}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} stroke="var(--color-line)" strokeDasharray="2 4" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              // The axis follows the data, not the requested window: OpenAQ's hourly values lag
              // the clock, and an axis running to "now" would leave an empty strip on the right.
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t: number) => TIME.format(t)}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-line)' }}
              minTickGap={32}
            />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={40}
              tickFormatter={(v: number) => formatValue(v)}
              domain={axisTop === undefined ? undefined : [0, axisTop]}
              allowDataOverflow={axisTop !== undefined}
            />
            {bands.map((c) => (
              <ReferenceArea
                key={c.label}
                y1={c.from}
                y2={Math.min(c.upTo, axisTop ?? c.upTo)}
                fill={c.colour}
                fillOpacity={0.25}
                stroke="none"
                ifOverflow="hidden"
              />
            ))}
            {classes?.[0] ? (
              <ReferenceLine
                y={classes[0].upTo}
                stroke="var(--color-ink)"
                strokeOpacity={0.6}
                strokeDasharray="4 3"
                label={{
                  value: `WHO guideline ${formatValue(classes[0].upTo)}`,
                  position: 'insideBottomLeft',
                  fill: 'var(--color-muted)',
                  fontSize: 11,
                }}
              />
            ) : null}
            <Tooltip
              cursor={{ stroke: 'var(--color-muted)', strokeDasharray: '3 3' }}
              formatter={(v) => [`${formatValue(Number(v))} ${unitText}`, property]}
              labelFormatter={(t) => DAY_TIME.format(Number(t))}
              contentStyle={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-line)',
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              // With bands the line is neutral and unfilled: a teal line and fill over the bands
              // would tint every class colour and make the line read as a class itself.
              stroke={classes === null ? 'var(--color-accent)' : 'var(--color-ink)'}
              strokeWidth={2.5}
              fill="var(--color-accent)"
              fillOpacity={classes === null ? 0.14 : 0}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <ReferenceDot
              x={latest.t}
              y={latest.value}
              r={5}
              fill={latestClass?.colour ?? 'var(--color-accent)'}
              stroke={latestClass ? 'var(--color-ink)' : 'var(--color-surface)'}
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <dl className="grid grid-cols-3 gap-3 text-sm">
        {[
          ['Latest', latest.value, TIME.format(latest.t)],
          ['Lowest', low, null],
          ['Highest', high, null],
        ].map(([label, value, note]) => (
          <div key={label as string} className="flex flex-col">
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
              {label}
            </dt>
            <dd className="font-semibold tabular-nums">
              {formatValue(value as number)}{' '}
              <span className="text-xs font-normal text-muted">{unitText}</span>
              {note ? (
                <span className="block text-xs font-normal text-muted">at {note}</span>
              ) : null}
              {label === 'Latest' && latestClass ? (
                <span className="block">
                  <ClassChip guideline={latestClass} unit={unitText} />
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {classes === null ? (
        <p className="text-xs text-muted">
          Hourly averages from OpenAQ, fetched when you open this tab and shown in your time zone.
        </p>
      ) : (
        <GuidelineKey
          classes={classes}
          unit={unitText}
          note="Points are hourly averages from OpenAQ, fetched when you open this tab and shown in your time zone. The bands are 24-hour levels, so one high hour does not mean the day exceeds them."
        />
      )}
    </div>
  )
}
