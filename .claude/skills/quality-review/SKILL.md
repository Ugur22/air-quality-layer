---
name: quality-review
description: Independent post-implementation review of an AirLayer diff for correctness, test quality, security boundaries, and unnecessary complexity. Use after implementing, before reporting done.
---

# Quality review

Review the diff as a skeptic, not the author. Read the acceptance criteria first, then the diff and its tests. Report only concrete findings with file and line, ranked by severity; say "no findings" per area if none.

## 1. Correctness
- Does each acceptance criterion have a code path, and does that path do what the criterion says?
- Edge cases: empty OpenAQ response, malformed upstream payload, out-of-range coordinates, duplicate sync start, retry of a job, terminal states being changed.
- Async and partial failure: a failed sync leaves no visible station readings; a retried job creates no duplicates.
- Behaviour matches `docs/domain.md` and `docs/api-contracts.md`; if the contract changed, run `api-contract-review`.

## 2. Tests
- Would each test fail if the feature were broken? Flag tautological tests, over-mocking (especially the database for PostGIS behaviour — only the OpenAQ HTTP call should be mocked), and assertions on implementation details.
- Are error paths and authorization (`404` cross-organisation) tested, not just the happy path?
- Were tests weakened, skipped, or deleted in this diff? Justify or reject.
- Check that reported test runs are real: which commands ran, with what result.

## 3. Security boundaries
- The OpenAQ response is treated as untrusted: shape, types, and coordinate ranges checked server-side before storage.
- Organisation scoping applied on every query, not only at the route.
- No secrets, tokens, or real data in code, fixtures, logs, or docs. The OpenAQ API key never reaches the frontend or logs.
- Error responses do not leak internals (stack traces, SQL, paths, the OpenAQ key).
- Migrations are non-destructive or have an approved plan (`docs/quality.md`).

## 4. Unnecessary complexity
- Anything beyond the acceptance criteria: unused options, speculative abstractions, new dependencies, refactors of untouched code.
- Duplicated logic that already exists elsewhere in the repo.
- Comments that say *what*; missing comments where the *why* is non-obvious.

## Output
Findings list (severity, location, problem, suggested fix), then: criteria not evidenced, checks not run, residual risks. Do not fix code in this pass unless asked.
