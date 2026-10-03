import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatAge } from '@/lib/freshness'
import { StationOverview } from './StationOverview'
import { StationTrend } from './StationTrend'
import { newestObservation } from './stationReadings'
import type { StationFeature } from './types'

type Tab = 'overview' | 'trend'

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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(90dvh,48rem)] w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-xl">
          <div className="flex items-start gap-3 px-5 pb-3 pt-5">
            <div className="min-w-0">
              <Dialog.Title className="font-display text-xl font-bold leading-tight">
                {station.properties.name}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted">
                OpenAQ station · {lat.toFixed(4)}°N, {lon.toFixed(4)}°E
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
            {(
              [
                ['overview', 'Overview'],
                ['trend', 'Trend'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`station-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`station-panel-${id}`}
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

          <div className="min-h-0 overflow-y-auto px-5 py-5">
            <div
              role="tabpanel"
              id="station-panel-overview"
              aria-labelledby="station-tab-overview"
              hidden={tab !== 'overview'}
            >
              <StationOverview
                station={station}
                stations={stations}
                property={property}
                now={now}
              />
            </div>
            <div
              role="tabpanel"
              id="station-panel-trend"
              aria-labelledby="station-tab-trend"
              hidden={tab !== 'trend'}
            >
              <StationTrend
                layerId={layerId}
                stationId={station.id}
                property={property}
                active={tab === 'trend'}
              />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
