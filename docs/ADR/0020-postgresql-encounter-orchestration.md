# ADR-0020: PostgreSQL-authoritative Encounter orchestration

Status: Accepted
Date: 2026-09-16

## Context

The original Foundation `EncounterService` proved the policy sequence with synchronous in-memory repositories. The durable database commands later became authoritative for consent, reservations, claim, Provider start, settlement, non-delivery, and reconciliation, but no application service composed those commands through the typed PostgreSQL adapter.

## Decision

Add an asynchronous `EncounterPersistencePort` and `PersistentEncounterOrchestrator`. Production composition requires `PostgresServerAdapter`; the in-memory service remains a unit-test substitute and is not a production fallback. The orchestrator appends hash-only safety evidence, reserves Compute and publication, claims the approved one-shot invitation, and records `START` before Provider I/O. A claim or persistence failure prevents Provider invocation and releases only pre-start reservations. Provider failure settles conservatively and persists non-delivery through existing atomic commands. Exact terminal replay is read from PostgreSQL, and a replayed claim never causes another Provider call.

There is no dual write. PostgreSQL remains authoritative for identity bindings, consent, locks, budgets, idempotency, and terminal state. Successful, redacted, blocked, and failed outcomes all delegate to existing atomic database commands. This slice intentionally does not add an HTTP handler, real Provider, production deployment, or friendship policy.

## Consequences

Runtime code is asynchronous and failure-closed. Blocked/failed paths create no Artifact, Life Event, Inbox, Post, or Memory. Successful delivery requires hash-bound output safety evidence and the existing atomic delivery command.

## Security and reversal

New functions are service-only and inherit the existing future-function default deny. Evidence stores hashes and classifications, never prompt/completion bodies or credentials. Reversal is removal of the composition entry point while retaining durable ledger facts; migrations and history are not rewritten.
