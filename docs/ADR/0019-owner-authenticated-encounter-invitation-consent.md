# ADR 0019: Owner-authenticated Encounter invitation consent

Status: Accepted  
Date: 2026-09-16

## Context

Encounter consumption already required an expiring, mutually approved one-shot invitation, but the original table encoded both approvals in an array at insertion time. That was suitable for the initial domain slice, not a durable proof that two authenticated Owners independently authorized the same frozen capability.

## Decision

Invitation issuance is an authenticated Owner command. Issuing binds both Owners, both active Social Twins, both active Social Persona versions, their source Identity Passport versions, the one-shot scope, expiry, purpose, and a context hash. Issuance is the initiating Owner's approval and creates a `PENDING` invitation. Only the authenticated responder Owner may add the second approval and transition it to `APPROVED`. The responder may instead transition it irreversibly to `REJECTED`.

Every decision is immutable private audit evidence. Actor identity and timestamps come from `auth.uid()` and the database clock. Idempotency is Owner-scoped and request-substitution resistant. Approval commands never accept an Owner identifier. The server-only execution claim remains separate and accepts only mutually approved, unexpired invitations whose frozen Persona and Identity versions are still active.

The lifecycle is:

`PENDING → APPROVED → CLAIMED → CONSUMED`

or:

`PENDING → REJECTED`

Expiry is a derived terminal eligibility state and never reactivates. Rejection, claim, consumption, or expiry prevents further decisions.

## Consequences

Owner clients can issue, approve, reject, and read participant-scoped invitations without direct table writes. Service roles cannot impersonate consent. Signing does not reserve Compute or publication capacity and creates no Artifact, Life Event, Inbox item, Post, or Memory.

## Security and privacy

Client commands receive only identifiers, bounded purpose text, hashes, versions, scope, and expiry. They store no prompt, completion, credential, private memory, or authorization token. RLS limits reads to participating Owners; all mutation tables remain client-write denied.

## Portability and reversal

The typed Owner adapter uses fixed parameterized PostgreSQL commands. A replacement store must preserve authenticated actor derivation, immutable version binding, dual consent, row-lock serialization, idempotency, and one-shot claim semantics. Existing consent evidence is not rewritten.

## Constitution implications

This strengthens explicit Owner authority, Social Twin separation, bounded activity, auditability, and default-deny persistence without expanding the product surface.
