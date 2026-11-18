# ADR 0015: Terminal recovery for stale unstarted Encounter claims

- Status: Accepted
- Date: 2026-09-13

## Context

ADR 0014 closes the pre-provider crash window by durably claiming a one-shot invitation before the Compute `START`. A worker can still crash after the claim but before `START`, leaving Compute and publication capacity reserved indefinitely. Automatically reopening the invitation would violate one-shot semantics and could duplicate an Encounter if an adapter ever performed external I/O out of order.

A different uncertainty exists after `START`: the provider may have accepted or charged the request even when no response or settlement reached our database. Absence of a terminal ledger fact is not evidence of zero usage.

## Decision

Add a service-only PostgreSQL command that recovers only a claimed Encounter whose latest Compute fact remains `RESERVATION/RESERVED`.

- A claim becomes recoverable after 15 minutes or when its invitation expires, whichever occurs first. Eligibility uses the database clock.
- Recovery serializes on the immutable claim, invitation, Compute transaction and both budget reservations.
- Recovery atomically releases Compute and publication reservations, consumes the one-shot invitation, and writes a claim-bound `FAILED / STALE_CLAIM_RECOVERED_BEFORE_PROVIDER` idempotency result.
- Recovery creates no Artifact, Life Event, Inbox item, Post, or Memory.
- Identical recovery retries replay the terminal result without returning capacity twice.
- If `START` exists, the command fails closed. Started work requires provider reconciliation and conservative settlement; it is never converted into a zero-cost cancellation.

The same Compute row lock serializes recovery against provider start. If recovery wins, a later start sees a terminal release and fails. If start wins, recovery sees `STARTED` and refuses to release.

## Consequences

- Crashes before provider I/O no longer hold budgets indefinitely.
- A claimed invitation is never silently made reusable, even when no Artifact is delivered.
- Recovery may sacrifice an Encounter that could otherwise have been retried; this is intentional fail-closed behavior for a one-shot capability.
- Started-but-unsettled attempts still require an operational reconciliation worker and provider-specific evidence.

## Reversal

A future lease design may supersede the fixed recovery window only if it preserves durable pre-I/O ordering, one-shot consumption, race serialization, immutable ledger history, and conservative handling after `START`. Existing claims and terminal facts must not be rewritten.
