# ADR 0011: Durable Compute lifecycle state machine

- Status: Accepted
- Date: 2026-09-13

## Context

An atomic reservation prevents concurrent overspend, but it is insufficient unless provider start, settlement, and pre-provider cancellation are also durable. Process-local state can lose whether external I/O began, double-settle usage after a retry, or release a reservation after a provider may already have charged it.

## Decision

PostgreSQL owns three additional private, service-only Compute transitions:

- `start_compute_transaction` appends exactly one `START/STARTED` fact immediately before provider I/O;
- `settle_compute_transaction` accepts only `STARTED`, locks the original budget, moves reserved counters to actual settled counters, and appends one terminal `SETTLEMENT`;
- `release_compute_transaction` accepts only a reservation that never started, restores reserved capacity, and appends `RELEASE/CANCELLED` without settled cost.

Every command locks the Owner-scoped transaction row. Identical terminal retries return the existing ledger fact without changing counters. A retry that substitutes usage, cost, status, provider request hash, or outcome is rejected. Missing reservation metadata or inconsistent counters fail closed.

These functions are `SECURITY DEFINER` with an empty `search_path`; only `service_role` may execute them. The immutable ledger remains the lifecycle source of truth rather than a mutable status column.

## Consequences

- A service restart can recover current state from the latest ledger sequence.
- Duplicate delivery of the same settlement cannot double-charge a budget.
- A started call cannot be released as if provider I/O never occurred.
- Actual provider usage is recorded even if it exceeds the original estimate; accounting cannot discard real cost to preserve a nominal cap.
- Stale-reservation detection, reconciliation entries, and provider-specific idempotency remain separate follow-up work.

## Security and privacy impact

Commands are Owner-scoped and cannot transition another Owner's transaction. Provider request identifiers remain hashed. No prompt, completion, credential secret, memory, or safety payload is stored in lifecycle commands or ledger facts.

## Portability impact

The lifecycle semantics are database-independent requirements. A future non-PostgreSQL adapter must reproduce row-level serialization, idempotent terminal replay, counter transfer, immutable ordering, and fail-closed recovery.

## Reversal plan

Functions may be superseded by versioned commands after equivalent transition and recovery tests exist. Historical ledger entries remain immutable and require no rewrite.

## Constitution implications

This decision strengthens Compute attribution and cost integrity without changing billing policy, Owner authority, Memory Firewall, Social Twin, Private Companion, or product scope.
