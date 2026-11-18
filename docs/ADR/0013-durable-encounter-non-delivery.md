# ADR 0013: Durable Encounter non-delivery outcomes

- Status: Accepted
- Date: 2026-09-13

## Context

An Encounter may terminate without delivery before provider I/O because input safety blocks it, or after provider I/O because generation fails or output safety blocks it. Process-local results are insufficient: a restart can lose idempotency, a retry can repeat paid work, and independently releasing publication or consuming an invitation can leave contradictory state.

The two cases have different capability semantics. An input block occurs before generation and should not spend Compute or publication capacity or consume the invitation. Once provider work starts, the attempt and its cost are real; its invitation must not be reusable even though no Artifact is delivered.

## Decision

PostgreSQL owns a private, service-only `persist_encounter_non_delivery` command.

- A pre-provider `BLOCKED` result requires matching private `INPUT/BLOCK` safety evidence. It records durable idempotency but preserves the invitation and accepts no Compute or publication reference.
- A post-provider `BLOCKED` or `FAILED` result requires a correctly scoped Compute transaction with immutable `START` and matching terminal settlement facts plus an active publication reservation. Output blocks additionally require matching private `OUTPUT/BLOCK` evidence; provider failures cannot claim such evidence.
- The provider `START.created_at`, rather than completion time, proves that paid work began within the invitation window. The terminal occurrence cannot precede that fact.
- Post-provider persistence atomically consumes the invitation, releases publication capacity, and records the durable result. It never creates an Encounter Artifact, Life Event, Inbox item, Post, or Memory.
- Identical retries return the stored result. Reuse of an idempotency key with changed inputs fails closed.

## Consequences

- Blocked and failed results survive restarts without becoming deliveries.
- Failed provider work remains cost-attributable while publication capacity is restored.
- Input safety rejection does not unnecessarily destroy an otherwise valid one-shot capability.
- The database adapter still needs a separate pre-provider invitation-consumption transition to close the crash window between provider start and terminal persistence.

## Security and privacy impact

Only `service_role` may execute the command. It validates Owner, Companion, active Social Twin, invitation consent, Compute scope, ledger status, publication scope, and safety evidence while affected rows are locked. Safety records remain hash-only in the private schema. Non-delivery cannot create recipient-facing or memory-bearing content.

## Portability impact

Any replacement persistence layer must preserve the split between pre-provider and post-provider semantics, immutable provider-start evidence, all-or-nothing publication release and invitation consumption, and durable substitution-resistant idempotency.

## Reversal plan

Supersede the command with a versioned state-machine procedure only after equivalent rollback, concurrency, Owner-isolation, and replay tests pass. Existing immutable ledger and idempotency facts are not rewritten.

## Constitution implications

This decision strengthens safety-before-generation, one-shot Social Twin capability use, publication-budget separation, and Compute attribution. It adds no Feed, DM, Home, Life Simulation, or implicit Memory write.
