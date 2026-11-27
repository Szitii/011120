# Architecture Decision Records

ADRs preserve decisions that protect Companion Social Platform's long-term direction from framework convenience and upstream project assumptions.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-domain-first-modular-monolith.md) | Domain-first modular monolith; no product fork | Accepted |
| [0002](0002-expo-supabase-api-first.md) | Expo/React Native + Supabase + API-first backend | Accepted |
| [0003](0003-memory-firewall-and-social-twin.md) | Private Companion/Social Twin split and permission-first retrieval | Accepted |
| [0004](0004-provider-routing-and-compute-ledger.md) | Internal provider contract and immutable compute ledger | Accepted |
| [0005](0005-open-source-adoption-policy.md) | Selective permissive adoption; legal gates for AGPL/BSL | Accepted |
| [0006](0006-bounded-import-firewall-foundation.md) | Bounded JSON import before binary or archive formats | Accepted |
| [0007](0007-versioned-social-projection-and-descriptor-first-memory.md) | Versioned allowlist projection and descriptor-first memory retrieval | Accepted |
| [0008](0008-append-only-compute-events-and-separate-publication-holds.md) | Append-only Compute events and separate publication holds | Accepted |
| 0009 | One-shot Encounter and Owner/Compute receipts | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| [0010](0010-database-owned-atomic-compute-reservation.md) | Database-owned atomic Compute reservation | Accepted |
| [0011](0011-durable-compute-lifecycle-state-machine.md) | Durable Compute lifecycle state machine | Accepted |
| 0012 | Atomic publication and Encounter delivery | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| 0013 | Durable Encounter non-delivery outcomes | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| 0014 | Pre-provider Encounter execution claim | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| 0015 | Terminal recovery for stale unstarted Encounter claims | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| 0016 | Conservative settlement for stale provider starts | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| [0017](0017-postgresql-runtime-adapter.md) | Typed PostgreSQL runtime adapter | Accepted |
| 0018 | Runner-agnostic stale-started reconciliation worker | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| 0019 | Owner-authenticated Encounter invitation consent | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| 0020 | PostgreSQL-authoritative Encounter orchestration | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| 0021 | Trusted claim-bound Encounter context snapshots | Superseded by [0024](0024-remove-encounter.md) (file removed) |
| [0022](0022-server-only-mvp-http-boundary.md) | Server-only versioned MVP HTTP/API boundary | Accepted |
| [0023](0023-provider-neutral-fast-decision-boundary.md) | Provider-neutral Fast Decision boundary; deterministic authority and confidence-gated signals | Accepted |
| [0024](0024-remove-encounter.md) | Remove Encounter | Accepted |

## Template

Each future ADR should include status/date, context, decision, consequences, security/privacy impact, portability impact, reversal plan, and Constitution implications. Supersede prior ADRs rather than silently editing historical decisions.
