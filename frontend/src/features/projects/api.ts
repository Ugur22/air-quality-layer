import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

export interface Project {
  id: string
  name: string
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await apiFetch<{ projects: Project[] }>('/projects')).projects,
  })
}
