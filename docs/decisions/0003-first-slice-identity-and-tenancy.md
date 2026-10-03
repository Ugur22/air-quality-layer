# 0003. Identity and tenancy in the first slice

- Status: accepted
- Date: 2026-10-02

## Context
The domain model scopes everything to an organisation, and the API contract assumes cross-organisation access returns `404`. Real authentication (provider, sessions, roles) is a large decision the first vertical slice does not need to answer. This mirrors Layerline ADR 0003 exactly; carried over because the tenancy shape is unchanged between the two projects.

## Decision
- The first slice uses a **placeholder identity**: the API resolves a request context (`organisation_id`, `actor_id`) through a single dependency. In development it reads them from configuration or a dev-only header; it is disabled by default outside development.
- **Organisation scoping is enforced in the data-access layer**: every repository query takes the request context and filters by `organisation_id`. Routes never build unscoped queries. Cross-organisation access returns `404`.
- Audit events record `actor_id` and `organisation_id` from the same context.
- Real authentication replaces the single dependency later, through a separate ADR, without changing callers.
- PostgreSQL row-level security is deferred.

## Alternatives considered
- Full auth now (OIDC or session login) — realistic, but delays the slice on a decision with no bearing on sync and rendering.
- No tenancy until later — cheap now, but retrofitting scoping into every query is error-prone.
- Row-level security from the start — strong guarantee, but more setup and harder to test early.

## Consequences
- The placeholder is not a security boundary; it must never be enabled outside development, and this is documented and tested.
- Tenancy tests (cross-organisation → `404`) exist from the first endpoint.
- Roles and permissions remain open.
