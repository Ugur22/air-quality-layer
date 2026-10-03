import { useMemo } from 'react'
import { RegionForm } from '@/features/regions/RegionForm'
import { useProjects } from '@/features/projects/api'
import { ResultPanel } from '@/features/layers/ResultPanel'
import { useMapLayer } from '@/features/layers/api'
import { isInFlight, useSyncJob } from '@/features/syncs/api'
import { SyncStatus } from '@/features/syncs/SyncStatus'
import { describeError } from '@/features/syncs/messages'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useSession } from '@/stores/session'

export default function App() {
  const projects = useProjects()
  const syncJobId = useSession((s) => s.syncJobId)
  const region = useSession((s) => s.region)
  const sync = useSyncJob(syncJobId)
  const job = sync.data
  const layer = useMapLayer(job?.status === 'succeeded' ? job.map_layer_id : null)

  // Ages are measured from when the stations were fetched, so every part of the page agrees.
  const fetchedAt = layer.dataUpdatedAt
  const now = useMemo(() => new Date(fetchedAt), [fetchedAt])

  const project = projects.data?.[0]
  // A failed poll means we no longer know the job is running, so the form must not stay locked.
  const busy = job !== undefined && isInFlight(job.status) && !sync.isError

  const regionSection = (
    <section aria-label="Define a region" className="flex flex-col gap-3">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        Region
      </p>
      <h2 className="font-display text-lg font-bold leading-tight">Define an area</h2>
      {projects.isPending ? (
        <p role="status" className="text-sm text-muted">
          Loading your project…
        </p>
      ) : projects.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{describeError(projects.error)}</AlertDescription>
        </Alert>
      ) : project === undefined ? (
        <p className="text-sm text-muted">
          This organisation has no project yet, so a region cannot be created.
        </p>
      ) : (
        <RegionForm projectId={project.id} busy={busy} jobFailed={job?.status === 'failed'} />
      )}

      {job ? <SyncStatus job={job} /> : null}
      {sync.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{describeError(sync.error)}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )

  return (
    <div className="flex min-h-dvh flex-col bg-paper text-ink lg:h-dvh lg:min-h-0">
      <header className="shrink-0 border-b border-line bg-surface">
        <div className="flex items-baseline gap-4 px-4 py-3">
          <h1 className="font-display text-xl font-bold tracking-tight">AirLayer</h1>
          <p className="text-sm text-muted">Air-quality stations for any region you define</p>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <ResultPanel
          rail={regionSection}
          title={region ? region.name : 'Stations'}
          loading={layer.isLoading}
          error={layer.isError ? describeError(layer.error) : null}
          layer={layer.data ?? null}
          now={now}
          idle={!busy && !layer.isLoading && !layer.isError}
        />
      </main>
    </div>
  )
}
