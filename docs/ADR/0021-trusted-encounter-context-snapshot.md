# ADR-0021: Trusted claim-bound Encounter context snapshots

Status: Accepted
Date: 2026-09-17

## Context

The PostgreSQL-authoritative Encounter orchestrator still accepted a caller-supplied Social Persona view and already-retrieved Memory representations. Database claim validation prevented ownership substitution in reservations and terminal writes, but those model-context bodies were not themselves loaded from the frozen Invitation boundary.

## Decision

The runtime command now accepts only identifiers, untrusted input, bounded retrieval count, idempotency, and trace data. A service-only preparation command supplies non-content identifiers needed for reservation. After the database creates the execution claim, a second service-only command locks and validates the claim, approved Invitation, both Owners and Social Twins, frozen Social Persona and Identity Passport versions, Compute transaction, scope, purpose, context hash, and expiry.

Only then does PostgreSQL select Memory descriptors in the responder's `SOCIAL` namespace. Private domains are excluded structurally; explicit deny overrides; `FRIEND_SHAREABLE` requires an active `SOCIAL_ENCOUNTER` grant; revoked, expired, cross-Owner, and cross-Companion records are excluded before representation access. The snapshot stores only presence markers or summaries, never full Memory bodies. Selection is deterministically ordered and bounded.

The immutable snapshot contains the public Persona projection, minimal authorized Memory representations, and a manifest binding the execution claim, Invitation, Encounter, Compute transaction, both identity chains, scope, purpose, Invitation context hash/expiry, Provider request hash, and ordered Memory IDs. The SHA-256 manifest hash is stable audit evidence. Identical replay returns the same snapshot even if permissions later change; altered replay parameters fail.

## Consequences

Provider context can no longer be supplied by a client or reconstructed by an in-memory fallback. Assembly failure occurs before Provider `START` and Provider I/O. A claimed attempt that cannot assemble remains eligible only for the existing stale-unstarted recovery path. Receipts, Compute ledger facts, logs, and errors receive hashes and identifiers, not raw Memory or prompt bodies.

## Scope and reversal

No HTTP handler, real Provider, deployment, friendship expansion, or new identity/Memory model is introduced. Reversal removes the orchestration use of the command; immutable snapshots already created remain audit facts.
