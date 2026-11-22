# ADR 0010: Database-owned atomic Compute reservation

- Status: Accepted
- Date: 2026-09-13

## Context

The deterministic Foundation service proves Compute policy and accounting behavior in memory, but a production adapter cannot safely reproduce reservation as separate `SELECT`, counter update, transaction insert, and ledger insert calls. Concurrent workers could overspend a hard cap, while a process restart could lose idempotency state. The existing synchronous domain repository interfaces also must not be made deceptively synchronous around network I/O.

## Decision

PostgreSQL owns the first durable Compute state transition through the private `companion_private.reserve_compute_transaction` command. One database transaction:

1. validates required attribution and bounded quantities;
2. serializes the Owner-scoped idempotency key with a transaction advisory lock;
3. returns the original decision for an identical replay and rejects request substitution;
4. reads the immutable reason registry and enforces billing and per-reason ceilings;
5. locks the active Owner/Companion budget row;
6. applies currency and hard-cap checks;
7. inserts the attributable `ComputeTransaction` envelope;
8. atomically updates reservation counters and appends `RESERVATION`, or appends an attributable `REJECTION` without spending budget.

The command is `SECURITY DEFINER`, has an empty `search_path`, and is executable only by the backend `service_role`. `anon` and `authenticated` clients retain no access to the private schema or command. Raw prompts, completions, credentials, and memory representations are not command parameters or ledger fields.

The migration adds nullable persistence metadata to historical `ComputeTransaction` rows. Transactions created through the new command always populate `budget_id`, `request_hash`, and reserved quantity fields. Existing immutable rows are not rewritten.

## Consequences

- Concurrent reservations serialize on the budget row and cannot pass a hard cap using stale counters.
- Idempotency survives process restarts without allowing a key to substitute another request.
- Rejections remain attributable and auditable while consuming no reserved budget.
- The TypeScript domain policy remains the fast deterministic pre-check, but PostgreSQL is the authoritative durable enforcement boundary.
- Provider start, terminal settlement, release, reconciliation, publication reservation, and Encounter finalization still require equivalent database commands before a real provider adapter is enabled.

## Security and privacy impact

Only identifiers, version attribution, estimates, budget amounts, hashes, and routing metadata cross this boundary. The private reason registry cannot be modified or read by client roles. Retry parents must belong to the same Owner. Database constraints continue to enforce Owner/Companion/Social Twin relationships.

## Portability impact

The domain model remains independent of a PostgreSQL client library. The transaction command is a persistence adapter contract and can be invoked by Supabase RPC or a backend SQL client. A different database must reproduce the same locking, idempotency, attribution, and append-only semantics.

## Reversal plan

The function can be superseded by a versioned backend transaction adapter after equivalent concurrency and recovery tests exist. Historical transactions and ledger entries remain valid; they must not be rewritten during replacement.

## Constitution implications

This decision strengthens Owner budget authority and the ComputeTransaction attribution requirement. It does not change Memory, Social Twin, Private Companion, publication, billing, privacy, or product-direction policy.

## Follow-up (2026-11-22)

The TypeScript pre-check mentioned above (`compute/policy.ts`, `compute/service.ts`) was removed together with the other in-memory domain services. PostgreSQL is the only enforcement point; see ADR-0020.
