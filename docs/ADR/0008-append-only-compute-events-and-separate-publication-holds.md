# ADR-0008: Append-only Compute events and separate publication holds

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

A mutable cost row cannot prove what was reserved before provider I/O, what a failed attempt actually cost, or whether later reconciliation rewrote history. Combining generation and publication quotas would also let available compute become unintended external action authority.

## Decision

Each provider attempt begins with an immutable ComputeTransaction attribution envelope and append-only ledger entries for reservation, provider start, settlement/release, and reconciliation. Corrections use signed cost deltas in new entries. Owner, Companion, reason, provider/model, tokens, cost, billing party, policy versions, trigger, trace, and attempt linkage remain queryable without storing prompt or completion bodies.

Activity/generation budgets reserve worst-case calls, tokens, and cost before provider I/O. Publication/delivery uses a separate reservation that is consumed only after output safety succeeds; blocked output releases it while retaining actual provider cost.

## Consequences

Adapters must start from a valid reservation and settle every attempt. Aggregates derive from immutable entries plus mutable reservation counters. Database adapters need atomic row locking and stale-reservation recovery before production use.

## Security and privacy

No model call can bypass attribution. BYOK and platform-funded safety remain visible but distinguish billing party. Ledger records hashes/references rather than prompts, completions, credentials, or private memory content.

## Portability and reversal

Provider adapters, pricing tables, and budget products can change without rewriting historical usage. A material ledger shape change requires a new projection/migration, not edits to old entries.

## Constitution impact

Implements ComputeTransaction attribution and separate activity/generation/publication budgets; no principle is amended.
