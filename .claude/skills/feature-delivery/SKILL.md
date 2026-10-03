---
name: feature-delivery
description: Deliver one bounded AirLayer feature or fix end to end (plan, implement, verify, assess). Use when asked to build or change a specific behaviour, not for pure Q&A or docs edits.
---

# Feature delivery

Full rationale: `docs/agent-workflow.md`. Follow in order.

1. **Scope.** Read `AGENTS.md` and only the docs the feature touches. State goal, constraints, out-of-scope, and 2–6 testable acceptance criteria. If the feature is bigger than one reviewable change, split it and deliver the first part.
2. **Check decisions.** Does it touch an API contract, migration, dependency, or an **Assumption/Open** item? If so, propose the change and get approval first; use `api-contract-review` for contract changes.
3. **Contract first.** Update `docs/api-contracts.md` (and OpenAPI/types once they exist) before or with the code.
4. **Test first where practical.** Write tests for the acceptance criteria; confirm they fail for the right reason.
5. **Implement** the smallest change that passes. No unrelated refactors, renames, or dependency bumps.
6. **Verify.** Run the checks from `docs/quality.md` that exist and apply. Exercise the feature itself for UI or flow changes. State any check that could not run.
7. **Assess.** Run `quality-review` on the diff via the `reviewer` agent (fresh context, stronger model, not self-approval). Pass it the acceptance criteria and the diff command; it has no memory of this session. Use the `explorer` agent for broad read-only searches earlier in the loop.
8. **Report.** Changes, evidence per acceptance criterion, checks run/not run, residual risks, docs updated.
9. **Codify.** Only if the lesson is repeatable, put it in the right doc (see `docs/agent-workflow.md` §6). Otherwise add nothing.

Stop and ask when an open question affects correctness, or the work would need a destructive operation.
