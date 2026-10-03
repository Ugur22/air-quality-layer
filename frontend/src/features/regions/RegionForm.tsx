import { useState, type SyntheticEvent } from 'react'
import { PlaceSearchBox } from '@/features/places/PlaceSearchBox'
import { useSession } from '@/stores/session'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { describeRequestFailure } from '@/features/syncs/messages'
import { useRegionSync } from './useRegionSync'
import { validateRegionForm, type FormErrors, type RegionFormValues } from './validation'

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
  const [errors, setErrors] = useState<FormErrors>({})
  const { start, retrySync, pending, error, canRetrySync } = useRegionSync(projectId, jobFailed)

  const submit = (event: SyntheticEvent) => {
    event.preventDefault()
    const result = validateRegionForm(values)
    if (!result.ok) {
      setErrors(result.errors)
      const first = FIELD_ORDER.find((field) => isInvalid(result.errors, field))
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
            aria-invalid={isInvalid(errors, 'name')}
            aria-describedby={describedBy(errors, 'name')}
          />
          <FieldError id="region-name-error" message={errors.name} />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">Bounding box</legend>
          <div className="grid grid-cols-2 gap-3">
            {COORDINATES.map(({ field, label, hint }) => (
              <div key={field} className="flex flex-col gap-1.5">
                <Label htmlFor={`region-${field}`}>
                  {label} <span className="font-mono text-xs font-normal text-muted">{hint}</span>
                </Label>
                <Input
                  id={`region-${field}`}
                  inputMode="decimal"
                  value={values[field]}
                  onChange={(e) => {
                    setDraftField(field, e.target.value)
                  }}
                  aria-invalid={isInvalid(errors, field)}
                  aria-describedby={describedBy(errors, field)}
                />
                <FieldError id={`region-${field}-error`} message={errors[field]} />
              </div>
            ))}
          </div>
          <FieldError id="region-bbox-error" message={errors.bbox} />
        </fieldset>

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
          <Button type="submit" disabled={pending || busy}>
            {pending ? 'Starting…' : 'Create region and sync'}
          </Button>
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
