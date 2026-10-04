import { useMemo } from 'react'
import { RegionForm } from '@/features/regions/RegionForm'
import { useProjects } from '@/features/projects/api'
import { ResultPanel } from '@/features/layers/ResultPanel'
import { useMapLayer, useNationalLayer } from '@/features/layers/api'
import { useCountries } from '@/features/national/api'
import { CountryPicker, NationalNotes, ViewSwitch } from '@/features/national/NationalView'
import { ApiError } from '@/lib/api'
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
  const national = useSession((s) => s.nationalView)
  const setNational = useSession((s) => s.setNationalView)
  const regionLayer = useMapLayer(job?.status === 'succeeded' ? job.map_layer_id : null)
  const country = useSession((s) => s.country)
  const setCountry = useSession((s) => s.setCountry)
  const countries = useCountries(national)
  const chosenCountry = countries.data?.find((c) => c.code === country)
  const countryName = chosenCountry?.name ?? country
  const nationalLayer = useNationalLayer(country, national)
  const layer = national ? nationalLayer : regionLayer
  const notBuiltYet =
    national && nationalLayer.error instanceof ApiError && nationalLayer.error.status === 404

  // Ages are measured from when the stations were fetched, so every part of the page agrees.
  const fetchedAt = layer.dataUpdatedAt
  const now = useMemo(() => new Date(fetchedAt), [fetchedAt])

  const project = projects.data?.[0]
  // A failed poll means we no longer know the job is running, so the form must not stay locked.
  const busy = job !== undefined && isInFlight(job.status) && !sync.isError

  const switcher = <ViewSwitch national={national} onChange={setNational} />

  const nationalSection = (
    <div className="flex flex-col gap-5">
      {switcher}
      <CountryPicker countries={countries.data} code={country} onChange={setCountry} />
      <NationalNotes
        country={{ code: country, name: countryName }}
        layer={nationalLayer.data ?? null}
        loading={nationalLayer.isLoading}
        notBuiltYet={notBuiltYet}
        now={now}
      />
    </div>
  )

  const regionForm = (
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

  const regionSection = (
    <div className="flex flex-col gap-5">
      {switcher}
      {regionForm}
    </div>
  )

  return (
    <div className="flex min-h-dvh flex-col bg-paper text-ink lg:h-dvh lg:min-h-0">
      <header className="shrink-0 border-b border-line bg-surface">
        <div className="flex items-baseline gap-4 px-4 py-3">
          <h1 className="font-display text-xl font-bold tracking-tight">AirLayer</h1>
          <p className="text-sm text-muted">
            Air-quality stations for any region you define, or a whole country
          </p>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <ResultPanel
          rail={national ? nationalSection : regionSection}
          title={national ? countryName : region ? region.name : 'Stations'}
          loading={layer.isLoading}
          error={layer.isError && !notBuiltYet ? describeError(layer.error) : null}
          layer={layer.data ?? null}
          countryView={national && chosenCountry ? chosenCountry : null}
          now={now}
          idle={!national && !busy && !layer.isLoading && !layer.isError}
        />
      </main>
    </div>
  )
}
