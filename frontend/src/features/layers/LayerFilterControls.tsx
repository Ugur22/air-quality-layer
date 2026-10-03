import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSession } from '@/stores/session'
import { COMPARATORS, type Comparator, type ParsedFilterValue } from './filter'

export function LayerFilterControls({
  property,
  parsed,
}: {
  property: string
  parsed: ParsedFilterValue
}) {
  const comparator = useSession((s) => s.filterComparator)
  const setComparator = useSession((s) => s.setFilterComparator)
  const value = useSession((s) => s.filterValue)
  const setValue = useSession((s) => s.setFilterValue)

  return (
    <fieldset className="flex flex-wrap items-end gap-3">
      <legend className="mb-1.5 text-sm font-medium">
        Show only stations where <span className="font-mono">{property}</span> is
      </legend>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="filter-comparator" className="sr-only">
          Comparison
        </Label>
        <select
          id="filter-comparator"
          value={comparator}
          onChange={(e) => {
            setComparator(e.target.value as Comparator)
          }}
          className="h-10 rounded-md border border-line bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {COMPARATORS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="filter-value" className="sr-only">
          Value
        </Label>
        <Input
          id="filter-value"
          inputMode="decimal"
          placeholder="e.g. 10"
          className="w-32"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
          }}
          aria-invalid={parsed.kind === 'invalid'}
          aria-describedby={parsed.kind === 'invalid' ? 'filter-value-error' : undefined}
        />
      </div>
      {value !== '' ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setValue('')
          }}
        >
          Clear filter
        </Button>
      ) : null}
      <p id="filter-value-error" aria-live="polite" className="basis-full text-xs text-bad">
        {parsed.kind === 'invalid' ? 'Enter a number such as 10 or -3.5.' : null}
      </p>
    </fieldset>
  )
}
