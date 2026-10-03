# Agent workflow

Detail for the loop in `AGENTS.md`: plan → implement → verify → assess → codify learning. The `feature-delivery` skill is the short operational version. This file is workflow, not domain, and is near-identical to Layerline's — the same loop applies regardless of what the project pulls data from.

## 1. Explore context

- Read `AGENTS.md`, then only the docs the task touches (see its index). Skim `docs/agent-lessons.md` for entries on this kind of task.
- Read the code you will change and its immediate neighbours, and existing tests. Search before creating; prefer extending what exists.
- Separate what is known (docs, code) from what you infer. Note any doc that contradicts the code.

## 2. Define constraints and acceptance criteria

Before editing, write down (in the task reply or plan):

- **Goal** in one sentence.
- **Constraints**: contract, schema, or decision boundaries touched; things that must not change.
- **Acceptance criteria**: observable, testable statements ("a sync against a bounding box with no OpenAQ stations yields a `succeeded` job with `station_count: 0`" or "failed" — whichever `domain.md`/`api-contracts.md` settles on). Not "works well".
- **Out of scope**, explicitly.
- **Assumptions and open questions.** If an open question blocks correctness (contract shape, data semantics, destructive change), ask; otherwise choose the most reversible option and record it.

Stop for approval before: changing a public contract, adding a migration, adding a dependency, making or reversing an ADR-worthy decision.

## 3. Implement

- Smallest change satisfying the criteria; match surrounding conventions.
- Tests alongside code. Contract-first for anything crossing the frontend/backend boundary.
- If the plan proves wrong mid-way, stop and re-plan; do not stretch scope silently.

## 4. Verify

- Run applicable checks from `docs/quality.md`; run new tests and see them fail before they pass where practical.
- For UI or flow changes, exercise the feature, not just the tests; if it cannot be exercised, say so.
- Before debugging a "still broken" report, check the thing being run is current: dev server or container start time versus the last change (`lsof -iTCP:<port>`, `docker compose ps`), and restart it.
- Report exact commands and results. Failures and skips are reported, never hidden.

## 5. Assess and report risks

Review your own diff against the acceptance criteria (or invoke `quality-review`). The final report contains:

- what changed and why (brief);
- criteria met, with the evidence for each;
- checks run, and checks not run with reasons;
- residual risks, assumptions made, follow-ups;
- any doc, contract, or ADR updated.

## 6. Capture reusable learning

Ask: would a future agent, on a different task, make the same mistake or repeat the same discovery? Only if yes, capture it:

| Kind of lesson | Destination |
|---|---|
| Fact about vocabulary or data model | `docs/domain.md` |
| Contract or API convention | `docs/api-contracts.md` |
| Verification rule or gap | `docs/quality.md` |
| Repeatable multi-step procedure | A skill in `.claude/skills/` |
| Decision with trade-offs | ADR in `docs/decisions/` |
| Plausible but unproven lesson | `docs/agent-lessons.md` |

Do not add to `AGENTS.md` unless the rule applies to nearly every task. One-off mistakes and task narration are not lessons.
