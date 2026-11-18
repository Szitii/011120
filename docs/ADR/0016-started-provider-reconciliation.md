# ADR-0016: Conservative reconciliation for stale provider starts

- **Status:** Accepted
- **Date:** 2026-09-16

## Context

A durable `START` proves that external provider I/O may have happened. If the worker then dies without writing a provider terminal result, treating the reservation as unused would hide possible spend and could reopen a one-shot capability. Absence of provider usage is uncertainty, not evidence of zero cost.

## Decision

Add a private, service-only PostgreSQL command for an Encounter execution claim whose latest Compute fact remains `START/STARTED`. After 15 minutes or invitation expiry, whichever occurs first, the command locks the claim, invitation, Compute transaction, Compute budget, and publication reservation. This lock order serializes it with normal settlement and Encounter finalization.

When no trustworthy terminal provider evidence exists, reconciliation charges the full reserved input, output, and cost ceilings. It appends an immutable `RECONCILIATION/RECONCILED` ledger fact and separately records the reason, evidence source, database time, hashed provider request identifier, original claim, and ledger association. It consumes the invitation, releases—never consumes—the publication reservation, and writes a claim-bound failed Encounter result. It does not retry the provider.

Repeated identical reconciliation returns the existing facts without changing counters. Changed evidence is rejected. A normal settlement that wins the Compute row lock makes reconciliation ineligible; reconciliation that wins makes later settlement ineligible.

## Security and privacy impact

The command validates the complete Owner, Companion, Social Twin, Encounter, invitation, Compute, and publication binding already frozen by the execution claim. Only `service_role` can execute it. No prompt, completion, raw provider identifier, Artifact, Life Event, Inbox item, Post, or Memory is created. Client roles retain default deny.

## Consequences

Unknown usage may be overcharged up to the previously approved ceiling; this is explicit, bounded, auditable, and safer than silently recording zero. A later trusted provider statement can be modeled as a separate signed ledger correction without rewriting the reconciliation fact.
