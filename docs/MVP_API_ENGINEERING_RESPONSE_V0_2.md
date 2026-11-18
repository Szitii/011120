# MVP API Engineering Response V0.2

Status: Engineering review complete locally; remote evidence is recorded only after CI.  
Handoff: `03-02-MVP-UX-API-2026-09-18-V1`  
Receiver response: **ACCEPTED WITH GAPS**

This is the Engineering artifact for the existing server-only HTTP/API boundary execution unit. It does not create a second backlog or runtime. The normative machine contract is `openapi/v0.yaml` (`0.2.0`). Endpoint names describe stable resources and do not encode client tab labels.

## Stable request context

The server derives the authenticated `viewer.ownerId` from a verified bearer session. Clients never submit an authoritative Owner ID. Read resources will return an `ActiveIdentityContext` containing active subject identity, viewer-to-subject relationship, view mode, immutable identity/persona versions when applicable, and server-derived capabilities. Until those reads are implemented they fail closed with `CAPABILITY_NOT_IMPLEMENTED`; clients must not infer a capability from missing fields.

The implemented command boundary accepts only the minimum untrusted fields. Encounter Persona, Memory content, prompt, provider configuration, service credentials, and authority are never client inputs. Existing PostgreSQL claim, dual consent, permission-first context assembly, immutable manifest, Social Twin/private-Memory separation, replay protection, and atomic terminal commands remain authoritative.

## Endpoint and resource mapping

| Product surface | Stable resource or operation | Status | Notes |
|---|---|---|---|
| World Home | `GET /v0/world-items`, `GET /v0/identity-context` | contract only | Authorized summaries; presentation and media fallback remain client concerns. |
| Companion Profile | `GET /v0/companions/{id}/profile`, identity/passport and projection contracts | contract only | Response must carry server-derived viewer capabilities. |
| Encounter Detail | `POST /v0/encounters`, `GET /v0/encounters/{id}`, receipts | POST + receipt implemented; detail contract only | POST delegates to persistent orchestration; detail must re-authorize every read. |
| Inbox / Life Event | `GET /v0/life-event-inbox`, invitation list/approve/reject | invitations implemented; event list contract only | Invitations use dual-Owner database consent. |
| Bring Companion | `/v0/companion-imports` and approval resources | contract only at HTTP boundary | Foundation import firewall exists in process; no HTTP production composition yet. |
| Controls | `GET/PATCH /v0/controls` | contract only | PATCH requires `If-Match` and idempotency when implemented. |

## Capability matrix

| Capability | Status | Authority / boundary |
|---|---|---|
| Bearer-required boundary and authenticated Owner session | implemented | `OwnerSessionResolver`; route logic never accepts Owner identity from body/query. |
| Issue/list/approve/reject one-shot Invitation | implemented | Owner-scoped adapter; PostgreSQL Auth/RLS and state machine. |
| Run bounded Encounter | implemented | Persistent orchestrator plus service-only PostgreSQL adapter. |
| Owner compute receipt | implemented | Owner-scoped reader; missing/cross-owner is non-disclosing. |
| World summaries and active identity context | contract only | Requires authorized read adapter. |
| Companion profile viewer capabilities | contract only | Requires authorized projection/read adapter. |
| Encounter terminal detail read | contract only | Requires participant-scoped read command. |
| Life Event inbox list/read acknowledgement | contract only | Write path exists; HTTP read/ack adapter does not. |
| Bring Companion HTTP composition | contract only | Existing in-memory firewall is not exposed as a production fallback. |
| Controls read/update with revision | contract only | Requires persistent settings and optimistic concurrency. |
| Long-term friendship/DM, Owner compose, Life Simulation, triggers, media generation | out of scope | No endpoint grants these capabilities. |
| Real Provider and production deployment | blocked by Approval Gates | Existing provider abstraction only. |

## Safe error matrix

| Condition | HTTP / safe code | Message class | Retry hint | Disclosure rule |
|---|---|---|---|---|
| Missing/invalid session | 401 `AUTHENTICATION_REQUIRED` / `INVALID_TOKEN` | `AUTH` | `DO_NOT_RETRY` | No token detail. |
| Denied operation | 403 `FORBIDDEN` | `PERMISSION` | `DO_NOT_RETRY` | Same public shape across policy causes. |
| Missing or hidden resource | 404 `RESOURCE_NOT_FOUND` | `PERMISSION` | `DO_NOT_RETRY` | Does not reveal cross-Owner existence. |
| Invalid body/header/media/size | 400/413/415 stable request code | `VALIDATION` | `DO_NOT_RETRY` | Field class only; no parser/SQL detail. |
| Stale state or substituted replay | 409 `REQUEST_CONFLICT` / `INVALID_STATE` | `CONFLICT` | `REFRESH_AND_RETRY` | No private state evidence. |
| Rate limit | 429 `RATE_LIMITED` | `RATE_LIMIT` | `RETRY_AFTER` | Contracted; runtime limiter is not installed. |
| Temporary database/runtime outage | 503 `SERVICE_UNAVAILABLE` | `AVAILABILITY` | `RETRY_SAME_REQUEST` | Same idempotency key required. |
| Partial authorized data | 200 plus explicit completeness marker | n/a | n/a | Contract only; never fill from unauthorized sources. |
| Capability unavailable | 501 `CAPABILITY_NOT_IMPLEMENTED` | `CAPABILITY` | `DO_NOT_RETRY` | Fail closed; no client authority emulation. |
| Unexpected failure | 500 `INTERNAL_ERROR` | `INTERNAL` | `RETRY_SAME_REQUEST` | Only trace ID is safe for support. |

Raw stack traces, SQL, provider secrets, prompts, private Memory IDs/content, policy evidence, and differentiated messages that imply sensitive data exists are prohibited.

## Page actions

| Page / action | Authentication | Capability source | Idempotency / replay | Main failure | Status |
|---|---|---|---|---|---|
| World Home: load items / switch subject | required | identity context + resource capabilities | GET; re-authorize after identity change | 401/404/501; partial marker | contract only |
| Companion Profile: view / invite | required | relationship and profile capabilities | GET; invitation POST exact replay | hidden 404; state 409 | profile contract only; invitation implemented |
| Encounter Detail: run / reload / receipt | required | approved Invitation, participant scope, database claim | POST key; exact terminal replay, substitution 409 | blocked/failed terminal; 403/409/503 | run + receipt implemented; detail contract only |
| Inbox / Life Event: list / approve / reject / mark read | required | participant or Owner inbox scope | decisions require key; irreversible conflict | 404/409 | invitation actions implemented; Life Event contract only |
| Bring Companion: upload / review / approve | required | Owner import capability and firewall | mutation key; exact replay only | fail closed | contract only at HTTP boundary |
| Controls: load / save revision | required | Owner controls capability | PATCH key + `If-Match`; stale 409 | refresh and retry | contract only |

## Acceptance scenarios AS 01–AS 10

| Scenario | Result | Gap and Stage 1 effect | This unit |
|---|---|---|---|
| AS 01 World → Encounter → return | GAP | Client navigation restoration plus World/detail reads. Blocks complete App journey, not HTTP contract evidence. | Endpoint semantics defined; 02/03 follow-up. |
| AS 02 Profile viewer capabilities | GAP | Profile read implementation; blocks Stage 1 App journey. | Stable capability/relationship contract added. |
| AS 03 identity switch rechecks Encounter permission | SUPPORTED | POST re-authenticates and DB rechecks Owner/Invitation; detail GET remains contract only. | Boundary covered without weakening. |
| AS 04 Inbox read/dedupe | GAP | Life Event list/read acknowledgement; blocks complete Inbox journey. | Invitation list exists; event contract retained. |
| AS 05 Bring Companion idempotency | GAP | HTTP composition gap; Foundation idempotency exists. Blocks complete import journey. | Contract requires key; no in-memory production fallback. |
| AS 06 Bring Companion fail closed | SUPPORTED | Foundation firewall fails closed; HTTP route is unavailable rather than bypassing it. | Non-bypass covered. |
| AS 07 Controls optimistic concurrency | GAP | Persistent controls implementation; blocks complete Controls journey. | `If-Match`, idempotency and 409 defined. |
| AS 08 no-media resilience | NOT APPLICABLE | Client presentation responsibility. | No server renderer. |
| AS 09 reduced motion | NOT APPLICABLE | Client accessibility responsibility. | No backend requirement. |
| AS 10 screenshot-native Moment | NOT APPLICABLE | Client presentation/share composition using authorized data. | No share-card renderer. |

## Receiver response and next handoff

**Receiver Response: ACCEPTED WITH GAPS.** Engineering accepts the handoff semantics and maps all six surfaces.

- 02 Engineering owns authorized World/profile/Encounter/Life Event read adapters, Bring Companion HTTP composition, and revisioned Controls persistence. These are Stage 1 App-boundary gaps in the same canonical execution stream.
- 03 Product Experience owns client navigation restoration, partial/no-media presentation, reduced motion, screenshot-native layout, and safe problem rendering.
- Founder: no decision requested. Real Provider, production deployment, credentials/payment, and scope expansions remain Approval Gates.

Next `02 → 03` status: **CONTRACT READY FOR PRODUCT VALIDATION; RUNTIME READ GAPS DECLARED**. The client may integrate against versioned shapes and implemented Invitation/Encounter/receipt operations, but must capability-gate every contract-only action.



## 2026-09-19 Stage 1 social residency implementation delta

This document originally captured the earlier handoff state. The following Stage 1 gaps were implemented in OpenAPI 0.6.0; the canonical contract later advanced to OpenAPI 0.7.0 for the revalidated public World feed and Owner-scoped Life continuity resources:

- `GET /v0/companions` now returns the authenticated Owner's Companion roster and distinguishes imported identity from activated social residency through `socialReady`.
- `PUT /v0/companions/{companionId}/social-persona` is implemented through the real HTTP boundary and PostgreSQL. It accepts only an Owner-selected allowlisted projection from the Companion's current approved identity and creates/updates the stable Social Twin.
- Import approval and social projection remain separate authorization moments. Approved private identity fields are not automatically public.
- Social activation keeps revisioned Controls coherent with the chosen visibility and autonomy while memory sharing remains `PERMISSION_GATED_SOCIAL_ONLY`.
- Cross-Owner social activation fails closed; anon cannot execute the projection function; idempotency, current-identity binding, global handle uniqueness, immutable persona versions, and audit evidence remain enforced.
- The disposable development HTTP smoke now proves a second imported Companion can complete import → approve → project/activate → roster `socialReady` → Companion identity context → profile read → Controls coherence.
- Encounter Provider execution and production auth/deployment remain outside this development unit.

Latest verified implementation evidence at this delta: companion-social main `4516160db2a7ad80604ac0ef7f1e918c97485e48`, Actions `35420125844` success. Later client-only polish may advance main without changing these server semantics.
