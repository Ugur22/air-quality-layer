import { ChevronDown } from 'lucide-react'
import { useState, type SyntheticEvent } from 'react'
import { PlaceSearchBox } from '@/features/places/PlaceSearchBox'
import { useSession } from '@/stores/session'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { describeRequestFailure } from '@/features/syncs/messages'
import { useRegionSync } from './useRegionSync'
import {
  boxProblem,
  isBoxEmpty,
  validateRegionForm,
  type FormErrors,
  type RegionFormValues,
} from './validation'

const COORDINATES: { field: keyof RegionFormValues; label: string; hint: string }[] = [
  { field: 'minLon', label: 'West', hint: 'min longitude' },
  { field: 'minLat', label: 'South', hint: 'min latitude' },
  { field: 'maxLon', label: 'East', hint: 'max longitude' },
  { field: 'maxLat', label: 'North', hint: 'max latitude' },
]

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className="text-xs text-bad">
      {message}
    </p>
  ) : null
}

const FIELD_ORDER: (keyof RegionFormValues)[] = ['name', 'minLon', 'minLat', 'maxLon', 'maxLat']
const BOX_FIELDS = new Set<keyof RegionFormValues>(['minLon', 'minLat', 'maxLon', 'maxLat'])

// A box-level error ("west must be smaller than east") belongs to all four coordinate inputs.
function isInvalid(errors: FormErrors, field: keyof RegionFormValues): boolean {
  return errors[field] !== undefined || (BOX_FIELDS.has(field) && errors.bbox !== undefined)
}

function describedBy(errors: FormErrors, field: keyof RegionFormValues): string | undefined {
  const ids: string[] = []
  if (errors[field] !== undefined) ids.push(`region-${field}-error`)
  if (BOX_FIELDS.has(field) && errors.bbox !== undefined) ids.push('region-bbox-error')
  return ids.length > 0 ? ids.join(' ') : undefined
}

export function RegionForm({
  projectId,
  busy,
  jobFailed,
}: {
  projectId: string
  busy: boolean
  jobFailed: boolean
}) {
  const values = useSession((s) => s.draft)
  const setDraftField = useSession((s) => s.setDraftField)
  const customAreaOpen = useSession((s) => s.customAreaOpen)
  const setCustomAreaOpen = useSession((s) => s.setCustomAreaOpen)
  const [errors, setErrors] = useState<FormErrors>({})
  const { start, retrySync, pending, error, canRetrySync } = useRegionSync(projectId, jobFailed)

  const boxEmpty = isBoxEmpty(values)
  const boxWrong = !boxEmpty && boxProblem(values) !== null
  // The numbers are shown when asked for, and while the box is wrong, so the problem is in view.
  const customOpen = customAreaOpen || boxWrong
  // Errors from the last submit say nothing once the box has since been fixed.
  const shownErrors: FormErrors =
    boxWrong || boxEmpty ? errors : errors.name ? { name: errors.name } : {}

  const submit = (event: SyntheticEvent) => {
    event.preventDefault()
    const result = validateRegionForm(values)
    if (!result.ok) {
      setErrors(result.errors)
      const first = FIELD_ORDER.find((field) => isInvalid(result.errors, field))
      // A wrong box keeps its section open, so every field with an error is on screen.
      if (first) document.getElementById(`region-${first}`)?.focus()
      return
    }
    setErrors({})
    start(result.value)
  }

  return (
    <div className="flex flex-col gap-5">
      <PlaceSearchBox />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Region">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="region-name">Name</Label>
          <Input
            id="region-name"
            value={values.name}
            onChange={(e) => {
              setDraftField('name', e.target.value)
            }}
            aria-invalid={isInvalid(shownErrors, 'name')}
            aria-describedby={describedBy(shownErrors, 'name')}
          />
          <FieldError id="region-name-error" message={shownErrors.name} />
        </div>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            aria-expanded={customOpen}
            aria-controls={customOpen ? 'custom-area' : undefined}
            aria-disabled={boxWrong}
            aria-describedby={boxWrong ? 'custom-area-reason' : undefined}
            onClick={() => {
              if (!boxWrong) setCustomAreaOpen(!customAreaOpen)
            }}
            className={cn(
              'flex w-fit items-center gap-1 rounded text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              boxWrong && 'cursor-default opacity-60',
            )}
          >
            <ChevronDown
              className={cn('size-4 transition-transform', customOpen ? '' : '-rotate-90')}
              aria-hidden
            />
            Custom area
          </button>
          {boxWrong ? (
            <p id="custom-area-reason" className="text-xs text-muted">
              Fix the box below to close this section.
            </p>
          ) : null}
          {customOpen ? (
            <fieldset id="custom-area" className="flex flex-col gap-3">
              <legend className="mb-1 text-sm text-muted">
                The area to load, as a box. Drawing on the map and choosing a place fill these in.
              </legend>
              <div className="grid grid-cols-2 gap-3">
                {COORDINATES.map(({ field, label, hint }) => (
                  <div key={field} className="flex flex-col gap-1.5">
                    <Label htmlFor={`region-${field}`}>
                      {label}{' '}
                      <span className="font-mono text-xs font-normal text-muted">{hint}</span>
                    </Label>
                    <Input
                      id={`region-${field}`}
                      inputMode="decimal"
                      value={values[field]}
                      onChange={(e) => {
                        setDraftField(field, e.target.value)
                        // The box turns valid part-way through typing a number; the section must
                        // not close under the user's hands then.
                        setCustomAreaOpen(true)
                      }}
                      aria-invalid={isInvalid(shownErrors, field)}
                      aria-describedby={describedBy(shownErrors, field)}
                    />
                    <FieldError id={`region-${field}-error`} message={shownErrors[field]} />
                  </div>
                ))}
              </div>
              <FieldError id="region-bbox-error" message={shownErrors.bbox} />
            </fieldset>
          ) : null}
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {error instanceof ApiError
                ? describeRequestFailure(error.code, error.message)
                : 'Something went wrong. Try again.'}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={pending || busy || boxEmpty}
            aria-describedby={boxEmpty ? 'sync-hint' : undefined}
          >
            {pending ? 'Starting…' : 'Create region and sync'}
          </Button>
          {boxEmpty ? (
            <p id="sync-hint" className="basis-full text-xs text-muted">
              Search for a place, draw an area on the map, or enter coordinates under Custom area
              first.
            </p>
          ) : null}
          {canRetrySync ? (
            <Button type="button" variant="outline" onClick={retrySync} disabled={pending}>
              Retry sync
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  )
}
