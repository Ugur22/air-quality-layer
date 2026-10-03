import type { GuidelineClass } from './mapData'

/** Swatch outline: the palest class would vanish against white without it. */
export function Swatch({ colour }: { colour: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 rounded-full border border-ink/70"
      style={{ background: colour }}
    />
  )
}

/** Which WHO class a value falls in, as a swatch plus the class range, never colour alone. */
export function ClassChip({ guideline, unit }: { guideline: GuidelineClass; unit: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <Swatch colour={guideline.colour} />
      <span className="tabular-nums">
        {guideline.label} {unit}
      </span>
    </span>
  )
}

/** Explains the bands drawn behind a chart; the wording is the same on every chart in the dialog. */
export function GuidelineKey({
  classes,
  unit,
  note,
}: {
  classes: GuidelineClass[]
  unit: string
  note: string
}) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>WHO 2021 24-hour guideline levels ({unit}):</span>
        {classes.map((c) => (
          <span key={c.label} className="inline-flex items-center gap-1.5">
            <Swatch colour={c.colour} />
            <span className="tabular-nums">{c.label}</span>
          </span>
        ))}
      </div>
      <p>{note}</p>
    </div>
  )
}
