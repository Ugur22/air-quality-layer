# 0005. Client state, data fetching, and pattern matching

- Status: accepted
- Date: 2026-10-02

## Context
The frontend needs server-state caching and polling (sync job status), local UI state (selected region, active filter), and exhaustive handling of the sync-job status enum. Layerline already validated a stack for this exact shape of need.

## Decision
TanStack Query for server state and polling, Zustand for UI state, ts-pattern for exhaustive matching over status enums — the same stack as Layerline ADR 0005, carried over unchanged.

## Alternatives considered
- Redux Toolkit — more ceremony than this app's UI-state needs justify.
- Plain `useState`/context for server state — would hand-rolled cache invalidation and polling that TanStack Query already provides well.

## Consequences
- Polling a sync job until a terminal status is a TanStack Query `refetchInterval`, same pattern as Layerline's import-job polling.
- Zustand stores are module-level singletons; tests must reset them (`docs/quality.md`).
