# AirLayer

AirLayer is a spatial-data operations platform: a Python backend pulls air-quality monitoring data from a public API (OpenAQ) for a user-defined region, validates and stores it, and a React map UI displays and filters the resulting layer. It is a portfolio project with two goals: a credible full-stack React + Python system, and a demonstration of disciplined AI-assisted engineering. It deliberately reuses the structure and working loop of a sibling portfolio project, Layerline, applied to a different domain and data source.

## Current phase

**Phase 1 — first vertical slice.** Backend (FastAPI, PostGIS, Procrastinate worker, Compose) and frontend (React, MapLibre) will implement: define a region (bounding box) → sync job pulls OpenAQ data → map layer with a property filter. Nothing beyond the scaffold and an empty app skeleton exists yet. Docs in `docs/architecture.md` and `docs/api-contracts.md` mark what is decided; anything still labelled Assumption or Open is not a fact about the codebase.

## Docs index (read only what your task needs)

| Doc | Read when |
|---|---|
| `docs/product.md` | Scoping a feature, judging whether something is in scope, defining the first vertical slice |
| `docs/domain.md` | Naming things, modelling data, touching any entity or relationship |
| `docs/architecture.md` | Choosing tech, structure, or boundaries; check its assumptions and open decisions first |
| `docs/api-contracts.md` | Adding or changing anything crossing the frontend/backend boundary |
| `docs/quality.md` | Deciding how to verify work, or what "done" requires |
| `docs/agent-workflow.md` | Starting any non-trivial task; it details the loop below |
| `docs/decisions/README.md` | Making or revisiting a meaningful decision (ADR rules and template) |
| `docs/agent-lessons.md` | Before repeating a kind of task; also where new reusable lessons are logged |

Project skills live in `.claude/skills/`: `feature-delivery`, `api-contract-review`, `quality-review`.

**Reading rule:** agents must read only the docs relevant to their task, plus this file. Do not load the whole `docs/` tree by default. If a doc you needed is missing or wrong, say so and fix it as part of the task rather than working around it.

## Status labels

Docs mark statements as **Decided**, **Assumption**, or **Open**. Never promote an assumption or open question to a decision silently; record it in an ADR (`docs/decisions/`) first.

## Quality and safety principles

- Bounded changes: one feature or fix per task; no drive-by refactors or unrelated dependency changes.
- Contract first: the API contract in `docs/api-contracts.md` changes before or together with the code that uses it.
- Validate at boundaries: data pulled from OpenAQ is untrusted input; validate shape, units, and geometry validity on the server before storing it. Never trust the upstream API to always return well-formed data.
- No secrets in the repo, logs, fixtures, or docs. The OpenAQ API key is an environment variable, never committed; use placeholder values in examples.
- Do not invent requirements, integrations, users, performance figures, or business claims. Ask or record an open question.
- Database changes go through reviewed migrations; never edit a schema by hand or destructively rewrite data without an explicit, approved plan.
- Do not run destructive commands (data deletion, `reset --hard`, force push, branch deletion) without explicit approval.
- Do not widen tool permissions, add MCP servers, or add CI/Docker configuration outside a task that asks for it.
- Do not commit unless asked.
- Comments explain *why*, never *what*.
- Report honestly: failing or skipped checks are stated with their output, not glossed over.

## Working loop

1. **Plan** — read the relevant docs, restate the goal, list constraints and testable acceptance criteria, note assumptions and risks. Get approval for anything that changes a contract, schema, or decision.
2. **Implement** — smallest change that meets the criteria, matching surrounding code.
3. **Verify** — run the checks in `docs/quality.md` that apply, once they exist; until then, say which checks are not yet possible.
4. **Assess** — review the diff against the acceptance criteria as a skeptic (use the `quality-review` skill); list residual risks and anything unverified.
5. **Codify learning** — if the task exposed a *repeatable* lesson, capture it (see below). Otherwise capture nothing.

Start bounded feature work with the `feature-delivery` skill and run `quality-review` before reporting done; both are part of the loop, not optional. Details and checklists: `docs/agent-workflow.md`.

## Where lessons go

`AGENTS.md` stays short and stable. It is not a changelog of past mistakes. A repeatable lesson goes to the narrowest place that will be read when it matters:

- domain, API, or quality rule → the relevant focused doc;
- a multi-step procedure → a skill in `.claude/skills/`;
- a significant choice with trade-offs → an ADR;
- a lesson not yet proven repeatable → `docs/agent-lessons.md`.

Add to this file only when a rule applies to nearly every task; prefer removing or tightening lines over appending.
