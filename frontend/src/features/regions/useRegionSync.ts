import { useMutation, useQueryClient } from '@tanstack/react-query'
import { startSync } from '@/features/syncs/api'
import { useSession } from '@/stores/session'
import { createRegion } from './api'
import type { Bbox } from './types'

/**
 * Create a region, then start its sync. The two requests are separate so that when only the
 * second fails the region is kept and "retry" starts a sync without creating a duplicate region.
 */
export function useRegionSync(projectId: string, jobFailed: boolean) {
  const queryClient = useQueryClient()
  const { setRegion, setSyncJobId, reset } = useSession.getState()
  const region = useSession((s) => s.region)

  const sync = useMutation({
    mutationFn: startSync,
    onSuccess: (job) => {
      // Seeds the poll's cache so the job is shown, and the form stays locked, from this moment
      // instead of after the first poll answers.
      queryClient.setQueryData(['sync', job.id], job)
      setSyncJobId(job.id)
    },
  })
  const create = useMutation({
    mutationFn: (input: { name: string; bbox: Bbox }) => createRegion(projectId, input),
    onSuccess: (created) => {
      setRegion(created)
      sync.mutate(created.id)
    },
  })

  return {
    start: (input: { name: string; bbox: Bbox }) => {
      reset()
      sync.reset()
      create.mutate(input)
    },
    retrySync: () => {
      if (region) {
        sync.reset()
        sync.mutate(region.id)
      }
    },
    pending: create.isPending || sync.isPending,
    error: create.error ?? sync.error,
    canRetrySync: region !== null && (sync.isError || jobFailed),
  }
}
