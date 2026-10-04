import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatAge } from '@/lib/freshness'
import { StationOverview } from './StationOverview'
import { StationTrend } from './StationTrend'
import { newestObservation } from './stationReadings'
import type { StationFeature } from './types'

type Tab = 'overview' | 'trend'
const TABS = [
  ['overview', 'Overview'],
  ['trend', 'Trend'],
] as const

function hemisphere(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(4)}°${value < 0 ? negative : positive}`
}

/**
 * What a click on a station opens: its latest readings against the other stations, and its trend
 * over the last day (fetched when that tab is opened). Closing it deselects the station.
 */
export function StationDialog({
  station,
  stations,
  layerId,
  property,
  now,
  onClose,
}: {
  station: StationFeature
  stations: StationFeature[]
  layerId: string
  property: string | null
  now: Date
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ overview: null, trend: null })

  // The ARIA tabs pattern: only the selected tab is in the Tab order; arrows, Home and End move.
  const onTabKey = (event: KeyboardEvent) => {
    const index = TABS.findIndex(([id]) => id === tab)
    const next = (
      {
        ArrowRight: (index + 1) % TABS.length,
        ArrowLeft: (index - 1 + TABS.length) % TABS.length,
        Home: 0,
        End: TABS.length - 1,
      } as Record<string, number | undefined>
    )[event.key]
    const target = next === undefined ? undefined : TABS[next]
    if (!target) return
    event.preventDefault()
    setTab(target[0])
    tabRefs.current[target[0]]?.focus()
  }
  const newest = newestObservation(station)
  const [lon, lat] = station.geometry.coordinates

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(92dvh,56rem)] w-[min(54rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-xl">
          <div className="flex items-start gap-3 px-6 pb-3 pt-6">
            <div className="min-w-0">
              <Dialog.Title className="font-display text-xl font-bold leading-tight">
                {station.properties.name}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted">
                OpenAQ station · {hemisphere(lat, 'N', 'S')}, {hemisphere(lon, 'E', 'W')}
                {newest ? ` · latest ${formatAge(newest, now)}` : ''}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="ml-auto size-9"
                aria-label="Close station details"
              >
                <X className="size-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>

          <div
            role="tablist"
            aria-label="Station details"
            className="flex gap-1 border-b border-line px-5"
          >
            {TABS.map(([id, label]) => (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el
                }}
                type="button"
                role="tab"
                id={`station-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`station-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onKeyDown={onTabKey}
                onClick={() => {
                  setTab(id)
                }}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  tab === id
                    ? 'border-accent text-ink'
                    : 'border-transparent text-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="min-h-0 overflow-y-auto px-6 py-6">
            <div
              role="tabpanel"
              id="station-panel-overview"
              aria-labelledby="station-tab-overview"
              hidden={tab !== 'overview'}
            >
              {tab === 'overview' ? (
                <StationOverview
                  station={station}
                  stations={stations}
                  property={property}
                  now={now}
                />
              ) : null}
            </div>
            <div
              role="tabpanel"
              id="station-panel-trend"
              aria-labelledby="station-tab-trend"
              hidden={tab !== 'trend'}
            >
              {tab === 'trend' ? (
                <StationTrend
                  layerId={layerId}
                  stationId={station.id}
                  property={property}
                  active
                  lastReported={newest ? formatAge(newest, now) : null}
                />
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
