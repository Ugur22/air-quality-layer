/** The middle value; for an even count, the mean of the two middle values. Null for no values. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] as number
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2
}

/** 1 for the highest value; equal values share a rank. */
export function rankFromHighest(values: number[], value: number): number {
  return values.filter((v) => v > value).length + 1
}

/** "1st", "2nd", "3rd", "11th", "21st". */
export function ordinal(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${String(n)}th`
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${String(n)}${suffix}`
}

/** A round upper bound for an axis: 36.4 gives 40, 7.6 gives 10, 316 gives 400. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const steps = [1, 2, 4, 5, 10]
  return (steps.find((s) => s * magnitude >= value) ?? 10) * magnitude
}
