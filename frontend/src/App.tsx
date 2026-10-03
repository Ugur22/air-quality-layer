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

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[90rem] items-baseline gap-4 px-6 py-4">
          <h1 className="font-display text-xl font-bold tracking-tight">AirLayer</h1>
          <p className="text-sm text-muted">Air-quality stations for any region you define</p>
        </div>
      </header>

      <main className="mx-auto grid max-w-[90rem] gap-6 p-6 lg:grid-cols-[24rem_1fr]">
        <section aria-label="Define a region" className="flex flex-col gap-5">
          <h2 className="font-display text-lg font-bold">Region</h2>
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

        <section aria-label="Result" className="flex flex-col gap-4">
          <h2 className="font-display text-lg font-bold">{region ? region.name : 'Map'}</h2>
          {layer.isLoading ? (
            <p role="status" className="text-sm text-muted">
              Loading stations…
            </p>
          ) : null}
          {layer.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{describeError(layer.error)}</AlertDescription>
            </Alert>
          ) : null}
          <ResultPanel
            layer={layer.data ?? null}
            now={now}
            idle={!busy && !layer.isLoading && !layer.isError}
          />
        </section>
      </main>
    </div>
  )
}
