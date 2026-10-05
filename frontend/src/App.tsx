import { useMemo } from 'react'
import { RegionForm } from '@/features/regions/RegionForm'
import { useProjects } from '@/features/projects/api'
import { ResultPanel } from '@/features/layers/ResultPanel'
import { useMapLayer, useNationalLayers } from '@/features/layers/api'
import { useCountries } from '@/features/national/api'
import { unionBbox } from '@/features/national/compare'
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
  const codes = useSession((s) => s.countries)
  const toggleCountry = useSession((s) => s.toggleCountry)
  const countries = useCountries(national)
  const frame = unionBbox(
    codes.flatMap((code) => {
      const bbox = countries.data?.find((c) => c.code === code)?.bbox
      return bbox ? [bbox] : []
    }),
  )
  const nameOf = (code: string) => countries.data?.find((c) => c.code === code)?.name ?? code
  const countryName = codes.map(nameOf).join(' and ')
  const nationalLayers = useNationalLayers(codes, national)
  const shown = national ? nationalLayers.layer : (regionLayer.data ?? null)
  const loading = national ? nationalLayers.loading : regionLayer.isLoading
  // A country whose layer has not been built yet is told in the rail, not shown as an error.
  const notBuilt = nationalLayers.errors.map((e) => e instanceof ApiError && e.status === 404)
  const nationalFailure = nationalLayers.errors.find((e, i) => e !== null && !notBuilt[i]) ?? null
  const loadError = national ? nationalFailure : regionLayer.isError ? regionLayer.error : null

  // Ages are measured from when the stations were fetched, so every part of the page agrees.
  const fetchedAt = national ? nationalLayers.updatedAt : regionLayer.dataUpdatedAt
  const now = useMemo(() => new Date(fetchedAt), [fetchedAt])

  const project = projects.data?.[0]
  // A failed poll means we no longer know the job is running, so the form must not stay locked.
  const busy = job !== undefined && isInFlight(job.status) && !sync.isError

  const switcher = <ViewSwitch national={national} onChange={setNational} />

  const nationalSection = (
    <div className="flex flex-col gap-5">
      {switcher}
      <CountryPicker countries={countries.data} codes={codes} onToggle={toggleCountry} />
      {codes.map((code, i) => (
        <NationalNotes
          key={code}
          country={{ code, name: nameOf(code) }}
          layer={nationalLayers.layers[i] ?? null}
          loading={nationalLayers.layers[i] === null && nationalLayers.errors[i] === null}
          notBuiltYet={notBuilt[i] ?? false}
          now={now}
        />
      ))}
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
          loading={loading}
          error={loadError ? describeError(loadError) : null}
          layer={shown}
          countryView={national && frame ? { codes, bbox: frame } : null}
          now={now}
          idle={!national && !busy && !loading && loadError === null}
        />
      </main>
    </div>
  )
}
