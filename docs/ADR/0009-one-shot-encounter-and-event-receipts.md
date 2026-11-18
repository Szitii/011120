# ADR 0009: One-shot Encounter and event/compute receipts

- Status: Accepted
- Date: 2026-09-13

## Context

The Foundation Vertical Slice needs to prove that two Companions can create a meaningful social event without prematurely building a Feed, persistent DM, or open-ended autonomous simulation. The interaction must preserve the Private Companion/Social Twin split, treat the other Twin's content as untrusted, prevent private-memory retrieval, and attribute every provider attempt and cost.

## Decision

V0 Encounter is an expiring capability with exactly one permitted provider attempt. Both participating Owners must approve the invitation. Only the initiating Owner may consume it, and both Social Twins must still be active and match the approved Owner scopes.

The execution order is fixed:

1. validate mutual consent, expiry, Owner scope, and active Social Twins;
2. deterministically scan/redact the untrusted inbound message;
3. reserve independent publication and Compute budgets;
4. run descriptor-first Memory Permission Gate retrieval for the responder's `SOCIAL` namespace and `SOCIAL_ENCOUNTER` purpose;
5. consume the invitation and append the Compute `START` event immediately before provider I/O;
6. validate provider usage, scan/redact output, and append terminal Compute settlement;
7. persist an artifact only for `DELIVERED` or `REDACTED` output and consume publication budget;
8. append one Owner-only Life Event and Inbox item for each participant;
9. derive the responder Owner's Compute Receipt from the append-only ledger.

Blocked input performs no provider call and does not consume the invitation. Once provider I/O starts, provider failure or blocked output still consumes the one-shot invitation and settles cost. Blocked/failed output releases publication capacity and creates no Artifact or Life Event.

Safety evidence stores hashes, threat categories, counts, decisions, and policy versions—not raw blocked content. A Life Event is evidence for Owner review; it is never automatically promoted to Memory, Post, identity, or relationship truth.

## Consequences

- The Vertical Slice demonstrates identity-to-social continuity, consent, permission-gated context, bounded activity, cost attribution, and a durable return surface in one narrow path.
- A retry with the same idempotency key returns the same in-flight/completed result. Request substitution is rejected.
- Provider adapters must honor configured token/cost ceilings. Malformed or over-ceiling usage fails closed and records a conservative terminal estimate for later reconciliation.
- The responder's Compute Receipt is not automatically disclosed to the initiating Owner.
- There is intentionally no conversational thread, reply loop, Feed distribution, autonomous follow-up, or implicit memory write.

## Security and privacy impact

Private memory descriptors are excluded before content search. The provider sees only the active public SocialPersona, authorized social-memory representations, and sanitized input explicitly typed `UNTRUSTED`. Output DLP runs before artifact persistence. RLS limits invitations/artifacts to participant Owners and Life Events/Inbox items to their owning Owner; authenticated clients receive no direct write path.

## Portability impact

The domain depends on repository and provider interfaces. It does not depend on Supabase, a particular model vendor, or a mobile UI framework. Compute Receipts are projections of portable ledger facts.

## Reversal plan

Future multi-turn interaction requires a new ADR and domain capability. It cannot silently reinterpret the one-shot invitation or turn Life Events into DM messages. This ADR may be superseded while preserving historical invitation, safety, Compute, artifact, and event records.

## Constitution implications

This decision implements, without weakening, Owner authority, the Memory Firewall, Social Twin separation, untrusted social input handling, pre-publication safety, bounded activity, and ComputeTransaction attribution.
