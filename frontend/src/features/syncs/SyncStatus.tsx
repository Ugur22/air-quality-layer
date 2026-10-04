import { AlertTriangle, CheckCircle2, LoaderCircle } from 'lucide-react'
import { match } from 'ts-pattern'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { describeSyncFailure, describeSyncWarning } from './messages'
import type { SyncJob } from './types'

function Progress({ title, detail }: { title: string; detail: string }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg bg-accent-soft p-3 text-sm">
      <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-accent" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted">{detail}</p>
      </div>
    </div>
  )
}

function stationText(count: number): string {
  return count === 1 ? '1 station' : `${String(count)} stations`
}

export function SyncStatus({ job }: { job: SyncJob }) {
  return match(job.status)
    .with('queued', () => (
      <Progress title="Waiting for a worker" detail="The sync is queued and will start shortly." />
    ))
    .with('processing', () => (
      <Progress
        title="Fetching stations"
        detail="Reading the latest values for every station in the region."
      />
    ))
    .with('succeeded', () => {
      const count = job.station_count ?? 0
      return (
        <div role="status" className="flex items-start gap-3 rounded-lg bg-accent-soft p-3 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" aria-hidden />
          <div>
            <p className="font-medium">
              {count === 0 ? 'No stations in this region' : `${stationText(count)} found`}
            </p>
            <p className="text-muted">
              {count === 0
                ? 'The sync worked, but no source has monitoring stations here.'
                : 'The latest readings are stored and shown on the map.'}
            </p>
            {job.warnings?.map((w, i) => (
              <p key={`${w.code}-${String(i)}`} className="mt-1 text-muted">
                {describeSyncWarning(w.code, w.message)}
              </p>
            ))}
          </div>
        </div>
      )
    })
    .with('failed', () => {
      const failure = job.errors[0]
      return (
        <Alert variant="destructive">
          <AlertTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-bad" aria-hidden />
            The sync failed
          </AlertTitle>
          <AlertDescription>
            {failure
              ? describeSyncFailure(failure.code, failure.message)
              : 'No reason was reported. Try again.'}
          </AlertDescription>
        </Alert>
      )
    })
    .otherwise(() => (
      <div role="status" className="text-sm text-muted">
        Status: {job.status}
      </div>
    ))
}
