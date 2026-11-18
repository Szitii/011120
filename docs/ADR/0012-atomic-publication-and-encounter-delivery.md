# ADR 0012: Atomic publication and Encounter delivery

- Status: Accepted
- Date: 2026-09-13

## Context

Compute completion does not authorize delivery. A successful bounded Encounter must also hold independent publication capacity, prove that output safety approved the exact sanitized body, consume a one-shot invitation, and create Owner-visible event evidence. Performing those writes independently can spend capacity without an Artifact, publish without consuming the invitation, duplicate Life Events after a retry, or persist output that does not match its DLP decision.

## Decision

PostgreSQL owns two private, service-only publication commands and one atomic successful-delivery command:

- `reserve_publication` locks the active Owner/Companion publication budget, persists Owner-scoped idempotency, and records either `RESERVED` or an attributable `REJECTED` decision;
- `complete_publication_reservation` permits exactly one `RESERVED` to `CONSUMED` or `RELEASED` transition and updates budget counters in the same transaction;
- `persist_delivered_encounter` accepts only a live mutually approved invitation, active Social Twins, a successfully settled and correctly scoped Compute transaction, a matching output-safety decision and sanitized-body hash, and the responder's active publication reservation.

The successful-delivery command atomically consumes the invitation, writes one immutable Artifact, writes one Owner-only Life Event and Inbox item for each participant, consumes publication capacity, and stores the durable Encounter result. Identical retries return the stored result. Request substitution fails closed.

Blocked or failed outputs cannot call the successful-delivery command because the Artifact status domain contains only `DELIVERED` and `REDACTED`, and the function requires matching `ALLOW` or `REDACT` output-safety evidence. They must release publication capacity through the separate terminal command and never create an Artifact or Life Event.

An authenticated, security-invoker `get_compute_receipt` query derives receipts from RLS-protected immutable Compute facts without returning prompts, completions, credentials, memory content, or private safety evidence.

## Consequences

- Publication capacity remains independent of generation capacity.
- A crash cannot leave only part of a successful Encounter delivery committed.
- Durable idempotency survives service restarts and prevents duplicate Artifacts or Inbox events.
- Safety approval is bound to the sanitized body by hash, not merely to an Encounter identifier.
- Failure/blocked-result persistence and stale-hold recovery remain separate follow-up work.

## Security and privacy impact

Only `service_role` can execute transaction commands. All functions use an empty `search_path`, validate Owner/Companion/Twin relationships, and lock affected rows. Life Events remain `OWNER_ONLY` and do not become Memory or Posts. Safety evidence stays in the private schema and contains hashes rather than raw blocked content.

## Portability impact

A future persistence adapter must reproduce transactional invitation consumption, publication counter serialization, body-to-safety binding, durable idempotency, and all-or-nothing Artifact/Life Event/Inbox creation.

## Reversal plan

The commands may be superseded by versioned procedures after equivalent concurrency, idempotency, RLS, and rollback tests exist. Immutable historical Artifacts, events, and ledger facts are not rewritten.

## Constitution implications

This decision strengthens the existing Memory Firewall, Social Twin, Owner authority, safety-before-publication, and Compute attribution principles. It adds no Feed, DM, Home, autonomous Life Simulation, or implicit Memory write.
