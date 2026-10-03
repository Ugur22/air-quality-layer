import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { POLL_INTERVAL_MS } from './polling'
import type { SyncJob } from './types'

export async function startSync(regionId: string): Promise<SyncJob> {
  const response = await apiFetch<{ sync_job: SyncJob }>(`/regions/${regionId}/syncs`, {
    method: 'POST',
  })
  return response.sync_job
}

async function getSync(syncJobId: string): Promise<SyncJob> {
  return (await apiFetch<{ sync_job: SyncJob }>(`/syncs/${syncJobId}`)).sync_job
}

/** The only statuses in which a sync is still running; anything else is shown but not waited for. */
export function isInFlight(status: string): boolean {
  return status === 'queued' || status === 'processing'
}

/** Polls while the job is in flight. A failed poll or a status it does not know stops polling. */
export function useSyncJob(syncJobId: string | null) {
  return useQuery({
    queryKey: ['sync', syncJobId],
    queryFn: () => getSync(syncJobId ?? ''),
    enabled: syncJobId !== null,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false
      const job = query.state.data
      return job === undefined || isInFlight(job.status) ? POLL_INTERVAL_MS : false
    },
  })
}
