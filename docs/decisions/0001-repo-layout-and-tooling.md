# 0001. Repo layout and tooling

- Status: accepted
- Date: 2026-10-02

## Context
AirLayer has a React + TypeScript frontend and a Python backend that share only the API contract — the same shape as Layerline, a sibling portfolio project whose tooling choices have already proven out. `docs/quality.md` needs one concrete command per check layer, so tooling must be named before scaffolding. Nothing is built yet.

## Decision
One repository with two independent packages, `frontend/` and `backend/`, each with its own tooling and lockfile. No monorepo build tool. A thin root Makefile wraps each package's commands, mirroring Layerline's.

- Frontend: Vite, React, strict TypeScript, npm, Vitest + Testing Library, ESLint + Prettier.
- Backend: Python 3.12+, uv for dependencies, Ruff (lint + format), mypy (strict on application code), pytest, Alembic for migrations.
- End-to-end runner: Playwright (ADR 0009).

## Alternatives considered
- Nx monorepo — strong for multiple JS packages, but adds config weight and little value for one JS package plus one Python package.
- Separate repositories — splits the contract and docs, and makes one-change-across-both-sides reviews harder.
- Re-deriving tooling choices from scratch instead of carrying over Layerline's — would relitigate decisions already validated in a sibling project with no new information.

## Consequences
- Each package must be runnable and checkable on its own; the root Makefile is convenience only.
- No shared generated types unless a later ADR adds a generation step from the OpenAPI schema.
- Revisit if a second JS package appears.
