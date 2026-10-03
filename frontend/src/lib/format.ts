const FORMAT = new Intl.NumberFormat('en', { maximumFractionDigits: 2, useGrouping: false })

/** Readings arrive with float noise (36.44749984741211); two decimals is more than the sensors justify. */
export function formatValue(value: number): string {
  const text = FORMAT.format(value)
  return text === '-0' ? '0' : text
}
