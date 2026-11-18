# ADR-0017: Typed PostgreSQL runtime adapter

- **Status:** Accepted
- **Date:** 2026-09-16

## Decision

Use `pg` (MIT) behind a narrow `SqlExecutor` and two explicit entry points: `PostgresServerAdapter` for service-role commands and `PostgresOwnerReader` for owner-scoped reads. The adapter issues only fixed parameterized calls to database functions; PostgreSQL retains transactions, locking, authorization binding, budgets, idempotency, and terminal-state authority.

| Domain operation | Database command | Typed result | Stable errors |
|---|---|---|---|
| Reserve Compute | `reserve_compute_transaction` | transaction/ledger/budget decision | invalid, conflict, forbidden, state |
| Reserve publication | `reserve_publication` | reservation/budget decision | invalid, conflict, forbidden, state |
| Claim Encounter | `claim_encounter_execution` | claim and database time | not found, conflict, forbidden, state |
| Mark provider start | `start_compute_transaction` | ordered ledger fact | not found, state |
| Reconcile stale start | `reconcile_stale_started_encounter` | conservative terminal result | not found, conflict, forbidden, state |
| Read receipt | `get_compute_receipt` | Owner-scoped receipt or no row | forbidden, database failure |

SQLSTATE values are translated without hiding their category. Connection failures never become successful business results. The adapter does not retry side-effecting commands and never accepts prompt, completion, memory, credential secret, or raw safety evidence fields.
