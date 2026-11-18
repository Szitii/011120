# ADR — Stage 1 Messaging Identity Semantics V1

Date: 2026-09-19  
Status: ACCEPTED SEMANTIC BOUNDARY / IMPLEMENTATION DEFERRED  
Scope: Stage 1 social architecture only

## Context

The Stage 1 running-client IA re-validation identified messaging as a product/domain boundary that must be defined before any DM UI is built. The current Stage 1 unit does not include long-term messaging implementation.

Messaging must not collapse Owner and Social Twin identities into one ambiguous chat principal, and message content must not silently cross Memory or Life boundaries.

## Decision

### Owner ↔ Owner

Stage 1 status: **DEFERRED**.

When implemented:
- participants are Owner principals;
- sender identity is an Owner principal;
- notifications belong to the Owner inbox;
- messages do not enter Companion Memory by default;
- Companion identities receive no automatic access.

No Owner↔Owner thread or UI is added in the current Stage 1 unit.

### Social Twin ↔ Social Twin

Stage 1 status: **SEMANTIC CONTRACT ONLY**.

Future thread principals are Social Twin identities, never private Companion runtime principals.

Required boundaries:
- both participants are explicit Social Twin principals;
- sending identity is fixed on each message;
- permission/block state is evaluated for the participating social principals;
- message input is untrusted social content and never authority;
- any memory access/write is limited to the SOCIAL namespace and remains policy-gated;
- private Companion Memory is not read or written by default;
- owning Owner may receive bounded notification according to Controls;
- private message body does not automatically become Owner-visible Life content;
- a safe Life summary would require an explicit separate policy/projection decision.

No long-term SocialTwin↔SocialTwin DM UI is added in the current Stage 1 unit.

### Owner ↔ own Companion

Stage 1 status: **PRIVATE RUNTIME / NOT SOCIAL DM / DEFERRED**.

This relationship belongs to private Companion interaction/runtime. It must not reuse social thread semantics merely because both identities appear in the same app.

## Minimum future contract shape

```
Thread {
  id
  kind: OWNER_OWNER | SOCIAL_TWIN_SOCIAL_TWIN
  participants[{ principalKind, principalId }]
  createdAt
  permissionState
  notificationPolicy
}

Message {
  id
  threadId
  senderPrincipalKind
  senderPrincipalId
  sentAt
  body/media
  deliveryState
}
```

## Viewer-sensitive state

The active app identity determines which principal is viewing/sending. Switching identity must purge viewer-sensitive thread state and reauthorize/refetch before message data is shown.

## Explicit non-decisions

This ADR does not define:
- message retention duration;
- E2EE;
- typing/presence;
- attachments;
- group threads;
- read receipts;
- long-term DM UI;
- private Owner↔Companion runtime chat.

Those remain outside this Stage 1 execution unit.

## Consequence

02/0203 must not add a DM tab or message screen based on guessed UI semantics. Future messaging implementation must first land explicit server contracts and permissions consistent with this ADR.
