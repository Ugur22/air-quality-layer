# Quality and verification model

Only the scaffold exists. `make check` runs backend and frontend checks (backend tests need `make up` for the database); `make e2e` runs the browser suite (`frontend/e2e/`) against the running stack; today it covers the map and drawing a region (`e2e/drawing.spec.ts`), not yet a full sync flow. CI does not exist yet, so nothing runs these automatically.

## Commands that exist

| Command | Runs |
|---|---|
| `make up` / `make down` | Compose stack: PostGIS, migrate step, API, worker |
| `make backend-check` | `ruff check`, `ruff format --check`, `mypy` (strict), `pytest` |
| `make backend-fix` | `ruff check --fix`, `ruff format` |
| `make frontend-check` | `tsc -b` (strict), `eslint` (typescript-eslint strict-type-checked), `prettier --check`, `vitest run` |
| `make frontend-fix` | `eslint --fix`, `prettier --write` |
| `make check` | Backend and frontend check suites |
| `make e2e` | Playwright in Chromium against the real UI and API (needs `make up`; starts or reuses the dev server). Covers what jsdom cannot: the map and its worker, and drawing a rectangle |

The API reloads on code changes; the Compose worker does not. After changing sync or job code, run `docker compose restart worker` before exercising the stack (e2e or by hand), or you are testing old code.

Backend tests run against a real PostGIS database (`airlayer_test`, recreated each session) and the real Procrastinate worker; they never touch the development database.

## Principles

- Each check has one command, documented here once it exists, that runs identically locally and (later) in CI.
- Verification is proportional: run the checks the change can affect, and all of them before declaring a task done.
- A bug fix starts with a test that fails for the right reason.
- A passing check is evidence only if it could have failed. Do not weaken, skip, or delete tests to get green.

## Checks

| Layer | Intended check | Tooling (Assumption) | Must catch |
|---|---|---|---|
| Frontend types | Strict TypeScript, no implicit `any` | `tsc --noEmit` | Contract drift, null handling |
| Frontend lint/format | Lint + format check | ESLint + Prettier | Style, hook misuse, unused code |
| Backend types | Static type check on all backend code | mypy (strict) | Type errors at API/DB boundaries |
| Backend lint/format | Lint + format check | Ruff | Style, common bugs |
| Backend tests | Unit tests for OpenAQ response validation; integration tests against a real PostGIS instance for persistence and API | pytest | Logic errors, malformed-upstream-response handling, SQL/geometry behaviour |
| Frontend tests | Component/unit tests for behaviour, not implementation details | Vitest + Testing Library | UI states: loading, error, empty, success |
| End-to-end | One flow per vertical slice, running the full stack | Playwright ([ADR 0009](decisions/0009-playwright-for-end-to-end-tests.md)) | Cross-layer breakage, browser-only failures |
| Migrations | See below | Alembic (Assumption) | Unsafe or irreversible schema changes |

## Backend test expectations

- OpenAQ response validation has table-driven tests covering: malformed JSON, missing fields, out-of-range coordinates, empty station list, upstream non-2xx, upstream timeout.
- Authorization: every endpoint has a test that a caller outside the owning organisation gets `404`.
- Tests must not depend on execution order or shared mutable state.
- Do not mock the database for behaviour that depends on PostGIS.
- The OpenAQ HTTP call is mocked at the test boundary (its contract is external and versioned by OpenAQ, not ours); the worker's handling of that response is not.
- Every way a sync can fail must end the job `failed` with an error code, never leave it `processing`.
- Queue behaviour is tested with the real worker (`run_worker_async(wait=False)`): retry then success, retries exhausted ending in a `failed` job, and idempotent reprocessing.

## Frontend test expectations

- Every async view has tests for loading, error, empty, and success states.
- Query by role/label/text, as a user would.
- Map rendering is tested at the boundary (data passed to the map component); pixel output is not asserted.
- Zustand stores are module-level singletons, so state leaks between tests. Reset every store a test touches in `beforeEach`.
- A test that depends on real timers (a debounce, a polling interval) is run repeatedly, 20 times, before it is trusted, and types without artificial delays: a debounce of a few milliseconds failed 1 run in 12 on a loaded machine because simulated keystrokes were further apart than the debounce.
- Browser tests that move the map must wait until the map is visually still before measuring a change, and a regression test is only trusted once it has been seen to fail with the fix removed (the first version of the Escape-mid-drag test passed with the bug present).
- jsdom has no WebGL, workers, or real bundling. Behaviour that depends on them (the map, its worker) is only verified in a real browser: run `make e2e`, and do not report it as verified from unit tests.

## Migration safety

- Every schema change is a migration file; the schema is never edited by hand.
- CI-equivalent check (intended): migrations apply cleanly to an empty database and to one at the previous revision.
- Destructive operations (drop column/table, type narrowing, data rewrites) need an explicit plan in the task and human approval: backup/rollback story, and a two-step expand/contract approach where data exists.
- A migration and the code that needs it ship together.
- Migration files are not edited after being merged; add a new one.
- Review every autogenerated migration before applying. `alembic/env.py` restricts autogenerate to tables our models define, same guard as Layerline, since the database also contains PostGIS extension tables and Procrastinate's tables.

## Definition of done

Acceptance criteria met and tested; applicable checks pass (or are stated as unavailable); docs/contract updated if behaviour changed; residual risks listed.
