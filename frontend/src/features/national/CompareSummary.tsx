import { useMemo } from 'react'
import { pollutantLabel } from '@/features/layers/pollutants'
import type { StationFeature } from '@/features/layers/types'
import { useCountries } from './api'
import { COUNTRY_COLOURS, summarise, type PollutantSummary } from './compare'

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })

const ROWS: { label: string; value: (s: PollutantSummary) => number | null }[] = [
  { label: 'Average', value: (s) => s.mean },
  { label: 'Median', value: (s) => s.median },
  { label: 'Lowest', value: (s) => s.min },
  { label: 'Highest', value: (s) => s.max },
]

/** Side-by-side figures for two countries, for the pollutant the map is coloured by. */
export function CompareSummary({
  stations,
  countries,
  property,
  now,
}: {
  /** The stations in view, of both countries; each carries the country it belongs to. */
  stations: StationFeature[]
  countries: string[]
  property: string
  now: Date
}) {
  const names = useCountries(true).data
  const summaries = useMemo(
    () =>
      countries.map((code) =>
        summarise(
          stations.filter((s) => s.properties.country === code),
          property,
          now,
        ),
      ),
    [stations, countries, property, now],
  )
  const unit = summaries.find((s) => s.unit !== null)?.unit ?? null
  const nameOf = (code: string) => names?.find((c) => c.code === code)?.name ?? code

  return (
    <section aria-label="Comparison" className="flex flex-col gap-3 border-t border-line pt-5">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        Comparison
      </p>
      <p className="text-sm text-muted">
        {pollutantLabel(property)}
        {unit ? `, ${unit}` : null}. Latest readings only; stale ones are left out.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left">
            <th scope="col" className="sr-only">
              Figure
            </th>
            {countries.map((code, i) => (
              <th key={code} scope="col" className="pb-1.5 text-right font-semibold">
                <span
                  aria-hidden
                  className="mr-1.5 inline-block size-2.5 rounded-full align-baseline"
                  style={{ backgroundColor: COUNTRY_COLOURS[i] }}
                />
                {nameOf(code)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line">
            <th scope="row" className="py-1.5 text-left font-normal text-muted">
              Reporting
            </th>
            {summaries.map((s, i) => (
              <td key={countries[i]} className="py-1.5 text-right tabular-nums">
                {s.reporting} of {s.stations}
              </td>
            ))}
          </tr>
          {ROWS.map((row) => (
            <tr key={row.label} className="border-t border-line">
              <th scope="row" className="py-1.5 text-left font-normal text-muted">
                {row.label}
              </th>
              {summaries.map((s, i) => {
                const value = row.value(s)
                return (
                  <td key={countries[i]} className="py-1.5 text-right tabular-nums">
                    {value === null ? '–' : number.format(value)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
