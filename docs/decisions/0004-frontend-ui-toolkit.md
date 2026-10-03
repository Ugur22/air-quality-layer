# 0004. Frontend UI toolkit

- Status: accepted
- Date: 2026-10-02

## Context
The frontend needs a component and styling approach for forms (region creation), lists (sync history), and map overlays (legend, filter controls). Layerline already validated a toolkit for this exact shape of app (a form + list + map layout).

## Decision
Tailwind CSS for styling, shadcn/ui (Radix primitives) for accessible unstyled-then-styled components, lucide-react for icons — the same stack as Layerline ADR 0004, carried over unchanged.

## Alternatives considered
- A component library with opinionated styling (MUI, Chakra) — faster initially, harder to make look distinctive; rejected in Layerline for the same reason.
- Re-evaluating the toolkit for this project — rejected: nothing about the air-quality domain changes the frontend's structural needs (forms, lists, map overlays) relative to Layerline.

## Consequences
- Same component conventions as Layerline; code and review habits transfer directly between the two projects.
- shadcn components are copied into the repo (`src/components/ui`), not installed as a dependency, and are excluded from lint rules that don't apply to generated code.
