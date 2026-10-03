import { apiFetch } from '@/lib/api'
import type { Bbox, Region } from './types'

export async function createRegion(
  projectId: string,
  input: { name: string; bbox: Bbox },
): Promise<Region> {
  const response = await apiFetch<{ region: Region }>(`/projects/${projectId}/regions`, {
    method: 'POST',
    body: input,
  })
  return response.region
}
