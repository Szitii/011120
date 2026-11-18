# ADR 0018: Operational stale-started reconciliation worker core

Status: Accepted  
Date: 2026-09-16

## Context

ADR 0016 established the locked, idempotent database settlement command. Operations still need a bounded way to discover eligible stale provider starts without copying eligibility or transaction logic into a scheduler.

## Decision

Add a service-only, keyset-paginated database candidate query and a runner-agnostic single-tick worker. The worker supplies an explicit cutoff, batch size, maximum item count, reason, and evidence source. It processes each candidate independently through the typed PostgreSQL adapter and returns identifiers, outcome classes, and stable error codes only.

The scan is advisory. `reconcile_stale_started_encounter` remains the final authority: it rechecks ownership, binding, staleness, current terminal state, reservations, and evidence while holding the established locks. A normal terminal settlement may win; the worker records that race as skipped and never retries the Provider.

## Consequences

Any CLI, server job, future cron, or queue consumer can invoke one tick. Production scheduling and provider-specific evidence retrieval are deliberately excluded. A failed candidate does not make other candidate outcomes ambiguous.

## Security and privacy

Only `service_role` can scan or reconcile. Client roles retain default deny. Summaries contain no prompt, completion, private memory, credential, raw provider identifier, or full evidence body. The worker creates no Artifact, Life Event, Inbox item, Post, or Memory and cannot silently convert unknown usage to zero cost.

## Portability and reversal

The core depends only on the persistence port; the PostgreSQL implementation uses fixed parameterized calls. Removing a runner does not change durable state semantics. Reversal removes the orchestration entry point, not immutable reconciliation facts.

## Constitution implications

This preserves database-owned safety, explicit Compute attribution, one-shot invitations, Owner isolation, least disclosure, and human-controlled deployment.
