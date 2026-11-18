# V0 Foundation Vertical Slice

Status: Executable domain slice complete

Last updated: 2026-09-13

## Ordered outcome

The Foundation Vertical Slice proves the narrow path below without implementing a general chat, Feed, DM, Home, or autonomous Life Simulation:

`External Companion → Import Firewall → Companion Identity / Identity Passport → Private Companion → versioned Social Twin projection → Memory Permission Gate → budget-limited Encounter → Life Event Inbox → Compute Receipt`

The implementation completes the executable domain path: External Companion JSON import, Import Firewall review/approval, immutable CompanionIdentity creation, versioned re-import, sanitized Identity Passport export, versioned SocialPersona projection, stable SocialTwin activation, descriptor-first memory authorization/retrieval, append-only ComputeTransaction accounting, mutually approved one-shot Encounter, output DLP, Life Event Inbox, and Owner-scoped Compute Receipt.

## Implemented contract

- Accept one bounded UTF-8 JSON character-card input shape: Character Card V2 or a limited legacy JSON object.
- Copy caller bytes before processing, calculate SHA-256, and hold the original only in the quarantine record.
- Enforce byte, nesting, node-count, individual-string, and aggregate-text limits before normalization.
- Reject invalid UTF-8/text, unsupported media, malformed JSON, nameless cards, and prototype-pollution keys.
- Treat every imported value as `EXTERNAL_UNTRUSTED`.
- Exclude prompt-bearing legacy fields from identity candidates.
- Recursively flag possible prompt injection, active content/URLs, credentials, PII, and unknown fields.
- Redact sensitive finding previews; evidence is represented by a hash in review output.
- Require explicit Owner approval of each candidate field; blocked candidates cannot be approved.
- Enforce Owner scoping and request-fingerprint idempotency for import and approval operations.
- Create a new immutable identity version on re-import instead of overwriting the active identity.
- Export an Identity Passport with provenance and explicit negative capability claims.
- Append sanitized audit evidence for accepted/rejected imports and identity approval.
- Require an unexpired, mutually Owner-approved, one-use invitation and active Social Twins.
- Issue that invitation through authenticated Owner commands: issuance records initiator consent, responder approval is independent, all Persona/Identity versions and context are frozen, and rejection or expiry cannot be reversed.
- Type every inbound social message as `UNTRUSTED`; deterministic safety may redact, limit, or block it but can never grant authority.
- Reserve publication and Compute independently before Memory retrieval or provider I/O.
- Retrieve only the responder's authorized `SOCIAL` memory namespace for the `SOCIAL_ENCOUNTER` purpose.
- Assemble that Persona and Memory context server-side only after the durable execution claim, persist an immutable manifest/hash snapshot, and prohibit caller-supplied context bodies.
- Atomically claim the one-shot invitation against exactly one Compute and publication reservation before allowing a social Provider `START`.
- Append provider start/settlement facts and validate provider-reported usage against the reserved envelope.
- Run output DLP before persistence; blocked/failed output creates no Artifact or Life Event and consumes no publication budget.
- Persist pre-provider input blocks without consuming the invitation; persist post-provider blocks/failures by atomically consuming the invitation, releasing publication, and recording restart-safe idempotency.
- Atomically consume the one-shot invitation and publication hold while writing the safety-authorized Artifact and one Owner-only Life Event/Inbox item for each participant.
- Persist successful Encounter idempotency across restarts and reject request substitution.
- Derive a credential-free, Owner-RLS-scoped Compute Receipt from immutable ledger entries.

## Explicit non-capabilities

- Imported system prompts, post-history instructions, examples, scenarios, lorebooks, URLs, extensions, credentials, and tool configuration never become trusted instructions.
- Approval does not create a Social Twin, a memory grant, provider configuration, or tool authority.
- Identity Passport does not contain raw quarantine bytes, private memory, credentials, executable instructions, or Social Runtime authority.
- The test adapter is deterministic and performs no external or paid model call. Every adapter invocation still requires a real reservation/start/settlement path; tests do not create fake zero-cost transactions.
- Encounter has no reply loop, persistent thread, Feed distribution, autonomous follow-up, or implicit Memory write.
- PNG cards, archives, URL imports, images, lorebook import, malware scanning, and automated identity summarization remain unsupported.

## Persistence boundary

Domain services depend on repository/provider interfaces. Current executable adapters are intentionally in-memory/scripted so policy behavior can be tested without infrastructure or paid services. Additive Supabase migrations define restricted import/safety schemas, immutable identity/social/Compute/artifact/event facts, budgets, transaction commands, constraints, and deny-by-default RLS.

An API/database adapter must preserve the same service contract. It may not move policy decisions into the client or permit direct authenticated-client writes to quarantine, identities, or audit data.

## Social projection and memory boundary

- SocialPersona fields are derived only from explicit Owner selections in an allowlisted mapping.
- The source must be the current approved identity version; stale identities cannot silently become public.
- Reprojection creates an immutable SocialPersona version while retaining the SocialTwin principal and SOCIAL namespace.
- SocialRuntimeView contains only public projection fields and the social namespace identifier.
- Memory descriptors are filtered by Owner, Companion, and namespace before content/ranking search.
- Explicit deny overrides allow. `FRIEND_SHAREABLE` and private domains require purpose-bound grants.
- Denied content is absent from retrieval candidates and access receipts.

## Verification

Run:

```bash
npm run check
```

The gate includes strict TypeScript checks and deterministic tests covering injection, credentials, PII, active content, unknown fields, nested metadata, cross-Owner access, raw-byte isolation, idempotency substitution, malformed/oversized inputs, explicit approval, sanitized export, and immutable version progression.

Compute tests additionally cover hard-cap refusal, reason/billing ceilings, reservation-before-provider ordering, idempotency, cancelled holds, failed/blocked cost settlement, compensating reconciliation, and independent publication consumption.

Encounter integration tests cover mutual consent, Owner scope, expiry, one-shot/idempotent execution, prompt injection, PII redaction, credential blocking, blank/oversized input, private-memory canaries, publication exhaustion, provider failure, malformed provider usage, output DLP, Life Event separation, and Owner-scoped receipts.

## PostgreSQL integration gate

The repository includes a disposable PostgreSQL 17 CI job that applies all migrations in order and then tests cross-Owner RLS visibility, Supabase-style default-grant removal, Auth subject-claim scoping, backend-only quarantine Storage policies, private-schema denial, direct-write denial, service-role transaction boundaries, immutable Artifact protection, mutual consent, service-only Compute/publication reservations, hard-cap rejection, pre-provider execution claims, rejection of unclaimed social starts, provider lifecycle ordering, stale unstarted claim recovery, rejection of zero-cost recovery after provider start, successful Encounter all-or-nothing delivery, blocked/failed non-delivery rollback and persistence, durable replay, request-substitution rejection, invitation claim/consumption, publication release/consumption, dual Owner-only Life Event/Inbox writes, and Owner-scoped receipt derivation. The runner has an explicit environment interlock and refuses a database whose `public` schema already contains tables.

## Deferred technical work

- Run the Supabase security contract against the local Supabase stack as an additional release gate; the PostgreSQL harness now reproduces and verifies default grants, Auth subject claims, Storage policies, and the service-role transaction boundary.
- Complete the remaining PostgreSQL transaction commands for identity version advancement and invitation issuance/approval. Compute lifecycle, publication lifecycle, pre-provider execution claim, stale unstarted recovery, stale started reconciliation with bounded worker orchestration, successful Encounter delivery, and terminal failed/blocked persistence are implemented.
- Wire the domain service to the PostgreSQL adapter; the in-memory adapter still provides process-local concurrency coalescing, while successful database delivery now has durable idempotency.
- Connect the in-memory Encounter orchestration service to the now-implemented Owner-authenticated invitation adapter; PostgreSQL issuance, dual approval/rejection, participant reads, immutable consent evidence, and claim eligibility are complete.
- Add a production provider adapter only after timeout, retry, tokenizer, pricing, and reconciliation behavior pass contract tests; no provider is configured now.
- Add streaming upload storage and isolated parsing before supporting binary cards or archives.
- Define a cryptographic issuer/signature scheme before calling Identity Passport externally verifiable.
- Add Unicode confusable normalization and multilingual detector benchmarks; deterministic detectors remain defense-in-depth and do not grant authority.
- Add an HTTP adapter generated against `openapi/v0.yaml` after the persistence adapter exists.
