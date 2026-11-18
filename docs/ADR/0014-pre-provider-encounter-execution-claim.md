# ADR 0014: Pre-provider Encounter execution claim

- Status: Accepted
- Date: 2026-09-13

## Context

The domain service consumes a one-shot invitation immediately before Provider I/O, but the first PostgreSQL transaction adapter originally wrote `used_at` only with the terminal delivery or non-delivery result. A process crash after Provider `START` and before terminal persistence could therefore leave the invitation looking reusable. Checking only the terminal ledger cannot prevent a second worker from starting duplicate paid work.

Changing already-applied migrations or relying on application ordering would weaken the database safety boundary.

## Decision

Add an immutable, private `EncounterExecutionClaim` between preflight and Provider `START`.

- `claim_encounter_execution` atomically binds one initiating Owner, Encounter, invitation, Compute reservation, publication reservation, request hash, and idempotency key.
- The command accepts only an unclaimed, unused, unexpired, mutually approved invitation; active participant Social Twins; a matching `SOCIAL_ENCOUNTER_RESPONSE` Compute transaction whose latest fact is `RESERVATION/RESERVED`; and a matching active publication reservation.
- Claiming writes `encounter_invitations.claimed_at`. Invitation state may transition only `unused → claimed → consumed`; neither transition is reversible.
- A database trigger refuses every social Encounter Compute `START` without a matching claim established first.
- A second trigger binds every delivered or post-provider non-delivery idempotency result to that same claim. Input safety blocks remain pre-claim and preserve the invitation.
- Terminal delivery/non-delivery still writes `used_at`; the claim remains immutable evidence of which reserved execution consumed the capability.

## Consequences

- A crash before Provider `START` leaves a durable, resumable claim instead of a reusable invitation.
- A worker cannot start two Compute transactions for one invitation, even if it changes idempotency keys.
- Successful, blocked, and failed terminal results all prove the same pre-provider authorization chain.
- Claimed-but-not-started and started-but-not-settled executions require a future stale-claim recovery policy; they must never silently become reusable invitations.

## Security and privacy impact

Only `service_role` may create a claim. The claim table is in the revoked private schema, contains identifiers and hashes rather than content, and is append-only. Owner, Companion, Social Twin, invitation, Compute, publication, timing, and Encounter scope are validated under row locks.

## Portability impact

Any replacement store must enforce a unique irreversible capability claim before social Provider I/O, reject unclaimed starts at the persistence boundary, and bind terminal results to the same claim.

## Reversal plan

Supersede the claim with a versioned lease/state-machine design only after it preserves one-shot semantics under crashes and concurrency. Existing claims, Compute facts, invitation transitions, and terminal results are not rewritten.

## Constitution implications

This closes an implementation gap in the existing one-shot Encounter and Compute attribution rules. It does not change the Memory Firewall, Social Twin authority, product direction, or V0 scope.
