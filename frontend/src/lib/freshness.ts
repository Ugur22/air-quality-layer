/** A reading observed this long ago or longer is shown as stale (decided with the user, ADR-free UI rule). */
export const STALE_AFTER_HOURS = 24

const HOUR = 3_600_000
const DAY = 24 * HOUR

export function isStale(observedAt: string, now: Date): boolean {
  // An unreadable timestamp is not claimed to be stale; formatAge says it is unknown.
  return now.getTime() - new Date(observedAt).getTime() >= STALE_AFTER_HOURS * HOUR
}

/** "under an hour ago", "5 h ago", "3 days ago", "7 months ago". */
export function formatAge(observedAt: string, now: Date): string {
  const observed = new Date(observedAt).getTime()
  if (Number.isNaN(observed)) return 'time unknown'
  const ms = Math.max(0, now.getTime() - observed)
  if (ms < HOUR) return 'under an hour ago'
  if (ms < DAY) return `${String(Math.floor(ms / HOUR))} h ago`
  const days = Math.floor(ms / DAY)
  if (days < 60) return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`
  const months = Math.floor(days / 30)
  return `${String(months)} months ago`
}
