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
| [0009](0009-one-shot-encounter-and-event-receipts.md) | One-shot Encounter and Owner/Compute receipts | Accepted |
| [0010](0010-database-owned-atomic-compute-reservation.md) | Database-owned atomic Compute reservation | Accepted |
| [0011](0011-durable-compute-lifecycle-state-machine.md) | Durable Compute lifecycle state machine | Accepted |
| [0012](0012-atomic-publication-and-encounter-delivery.md) | Atomic publication and Encounter delivery | Accepted |
| [0013](0013-durable-encounter-non-delivery.md) | Durable Encounter non-delivery outcomes | Accepted |
| [0014](0014-pre-provider-encounter-execution-claim.md) | Pre-provider Encounter execution claim | Accepted |
| [0015](0015-stale-unstarted-encounter-recovery.md) | Terminal recovery for stale unstarted Encounter claims | Accepted |
| [0016](0016-started-provider-reconciliation.md) | Conservative settlement for stale provider starts | Accepted |
| [0017](0017-postgresql-runtime-adapter.md) | Typed PostgreSQL runtime adapter | Accepted |
| [0018](0018-operational-stale-started-reconciliation-worker.md) | Runner-agnostic stale-started reconciliation worker | Accepted |
| [0019](0019-owner-authenticated-encounter-invitation-consent.md) | Owner-authenticated Encounter invitation consent | Accepted |
| [0020](0020-postgresql-encounter-orchestration.md) | PostgreSQL-authoritative Encounter orchestration | Accepted |
| [0021](0021-trusted-encounter-context-snapshot.md) | Trusted claim-bound Encounter context snapshots | Accepted |
| [0022](0022-server-only-mvp-http-boundary.md) | Server-only versioned MVP HTTP/API boundary | Accepted |
| [0023](0023-provider-neutral-fast-decision-boundary.md) | Provider-neutral Fast Decision boundary; deterministic authority and confidence-gated signals | Accepted |

## Template

Each future ADR should include status/date, context, decision, consequences, security/privacy impact, portability impact, reversal plan, and Constitution implications. Supersede prior ADRs rather than silently editing historical decisions.
