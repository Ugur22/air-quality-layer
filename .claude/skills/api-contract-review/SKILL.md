---
name: api-contract-review
description: Review any change to the frontend/backend contract (endpoints, request/response shapes, error codes, status enums). Use before implementing or when reviewing such a change.
---

# API contract review

Compare the proposed change against `docs/api-contracts.md` and `docs/domain.md`. Report findings per item; mark each pass / fail / not applicable.

## Checks

1. **Single source.** The contract doc (and OpenAPI/generated types once they exist) matches the implementation on both sides. Nothing is defined only in frontend or backend code.
2. **Compatibility.** Classify the change: additive (new optional field/endpoint), or breaking (removed/renamed field, type change, new required input, changed status code or enum meaning). Breaking changes need a versioned path or an ADR, and an explicit migration plan for the client.
3. **Vocabulary.** Names match `domain.md`; no synonyms introduced (e.g. "dataset" or "upload" instead of "region"/"sync job").
4. **Status and errors.** Success codes are accurate (`202` for async work). Errors use the shared error shape with a stable `code`; the client never parses `message`.
5. **Enums and nullability.** Every enum value is listed and handled by the client (including unknown values). Fields that are conditionally null (e.g. `map_layer_id` before success) state the condition.
6. **Authorization.** The endpoint states who may call it; cross-organisation access returns `404`, not `403` or data.
7. **Untrusted input.** Server validates the OpenAQ response's shape and values before storing them; limits are documented, or listed as **Open**. The frontend never calls OpenAQ directly or sees the OpenAQ API key.
8. **Async semantics.** Sync-job states and terminal-state rules match `domain.md`; retries and duplicate sync starts have defined behaviour.
9. **Size and pagination.** Responses that can grow are bounded or paginated, or the unbounded case is marked as first-slice-only.
10. **Tests.** Backend has a contract-level test for success and each documented error; frontend handles each documented state.

## Output
List failures with the doc line or code location, the fix, and whether the change is additive or breaking. If the doc and code disagree, do not pick one silently: report it.
