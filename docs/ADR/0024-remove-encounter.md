# ADR-0024: Remove Encounter

- **Status:** Accepted
- **Date:** 2026-11-27
- **Supersedes:** 0009, 0012, 0013, 0014, 0015, 0016, 0018, 0019, 0020, 0021, and the publication-hold half of 0008

## Context

Encounter (相遇) let two Owners' Social Twins meet once, under a mutually approved invitation, with
reserved compute and publication budgets, a claim before the provider call, and recovery for claims
that stalled. It was built before the product had chat or a community. It never ran in production:
no host ever called it. On 2026-11-23 the server-side run was removed (orchestrator, worker,
invitation and receipt routes). A read route for an Encounter's detail and every database object stayed.

## Decision

Remove what was left:

- the `GET /v0/encounters/{encounterId}` route and its types;
- in the database (migration `202611270079_remove_encounter.sql`): the Encounter tables and functions,
  publication budgets and reservations, and provider call reconciliations, which only Encounter used.
  The migration refuses to run if any of those tables holds a row;
- `list_world_items` no longer looks for Encounter detail (`openDetail` is always false) and
  `list_life_continuity` returns Life Events only;
- the ten ADRs listed above. They stay readable in git history.

Kept: life events and their inbox (the inbox also carries Companion draft notices), the compute ledger
and its reserve/start/settle/release functions (chat uses them), and the words `ENCOUNTER`,
`SOCIAL_ENCOUNTER` and `encounter-safety/0.1.0` in a few allowed-value lists and labels, because
removing them would rewrite tables for no gain.

## Consequences

- Less code and schema to read and keep secure; no route returns Encounter data.
- The frontend still has an Encounter page. It can never be opened now (no item links to it) and is
  for the frontend to delete.
- Bringing Encounter back means designing it again on today's chat and community, not restoring this.
