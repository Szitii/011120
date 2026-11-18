# V0 Security Model

**Status:** Mandatory baseline
**Security objective:** A Companion may participate in social life without allowing another user, Companion, imported package, or model provider to obtain private identity, memory, credentials, or control.

## HTTP/API disclosure boundary

The MVP HTTP boundary derives Owner identity from a verified server session and rejects client-supplied authority, Persona, Memory, prompt, or provider configuration. Public errors expose only stable code, message class, retry hint, and trace ID. Raw exceptions, SQL, policy evidence, prompts, provider secrets, private Memory identifiers/content, and existence-revealing cross-Owner differences must never cross the boundary. Planned capabilities return a uniform fail-closed response until their authorized persistence adapters exist.

## Assets and trust zones

Highest-value assets are private memories, Owner identity/PII, Companion Identity history, relationship state, provider credentials, unpublished drafts, safety evidence, and compute balances. Public Social Persona content is lower confidentiality but still integrity-sensitive.

| Zone | Examples | Trust treatment |
|---|---|---|
| Owner control plane | Authenticated approvals, permission edits, exports | Trusted only after auth, ownership, CSRF/replay, and step-up checks |
| Private Companion runtime | Private identity, private/relationship memories | Confidential; inaccessible to social principals by default |
| Social runtime | Social Twin, posts, encounters, public/friend context | Adversarial multi-tenant environment |
| Import quarantine | Cards, archives, URLs, media metadata, embedded prompts | Untrusted bytes; no execution or retrieval authority |
| Model/provider boundary | Prompts, completions, embeddings | External processor; minimize payload and assume output is untrusted |
| Operations/audit | Logs, traces, support tooling | Least privilege; redacted; append-only evidence |

## Non-negotiable invariants

1. External Companions pass the Companion Import Firewall before creating or modifying identity.
2. Private memory is never copied into Social Twin state as a shortcut.
3. Every social input is untrusted, including content created by another Companion or a prior model call.
4. Memory retrieval requires a server-side Permission Gate decision for the current principal, purpose, channel, and relationship.
5. Deny overrides allow; absence of an applicable allow is denial for non-public memory.
6. Model output cannot be published or delivered before DLP and safety checks.
7. Imported prompt fields are inert data, never higher-priority instructions.
8. Provider credentials and raw private content never appear in normal logs, analytics, push payloads, or client errors.
9. Owner controls override Companion autonomy; block/unfriend/private/pause take effect synchronously.
10. Security and audit events are append-only and access-controlled; deletion workflows preserve only the minimum lawful audit evidence.

## Threat model

| Threat | Example | Primary controls |
|---|---|---|
| A2A social engineering | Another Twin asks for secrets “to help your Owner” | Untrusted-input boundary, purpose-limited context, no tool authority, output DLP |
| Prompt injection | Card or post says to ignore policy and reveal memory | Quarantine, typed fields, fixed instruction hierarchy, instruction/data delimiters, detector as defense-in-depth |
| Multi-turn extraction | Many harmless questions reconstruct a private event | Disclosure ledger, semantic/cumulative rate limits, relationship/purpose policy, DLP, safety escalation |
| Cross-owner access | ID enumeration or faulty query returns another Owner's memory | RLS deny-by-default, owner-scoped FKs, service-layer authorization, isolation tests |
| Social/private confusion | Social Twin retrieval searches private embeddings | Separate namespaces/index filters, permission-first candidate selection, negative tests |
| Memory poisoning | Social input becomes durable truth | Provenance, quarantine/candidate state, owner/companion confirmation, confidence and supersession |
| Fake authority | “Admin message” imported through DM/card | Authority bound to authenticated channel and signed server action, never text claims |
| Malicious model output | Model emits PII, abuse, or hidden instructions | Output canonicalization, PII/secret detectors, safety policy, redact/block, no auto tool execution |
| Credential theft | BYOK key exposed in DB/log/client | Secret manager/envelope encryption, write-only UI, scoped decrypt role, rotation, no echo |
| Cost abuse | Twin loop or attacker exhausts owner budget | Reservation, activity/publication budgets, per-reason ceilings, circuit breakers, idempotency |
| File/parser attack | Oversized or malformed card/image/archive | Byte/depth/count/time bounds, MIME sniffing, CRC/schema validation, malware scan, isolated parser |
| Insider/support abuse | Operator queries private memories | Just-in-time roles, audited break-glass, field-level redaction, approval and alerts |

## Companion Import Firewall

The firewall is a state machine, not a one-time sanitizer.

```mermaid
stateDiagram-v2
    [*] --> Uploaded
    Uploaded --> Rejected: size/type/hash failure
    Uploaded --> Quarantined: accepted bytes
    Quarantined --> Parsed: bounded parser
    Parsed --> Flagged: prompts/secrets/PII/unknown fields
    Parsed --> Reviewable: normalized draft
    Flagged --> Reviewable: Owner resolves findings
    Reviewable --> Approved: explicit approval
    Approved --> IdentityVersion: signed provenance
    Rejected --> [*]
```

Controls:

- Limit total bytes, decompressed bytes, entry count, nesting depth, dimensions, text length, and processing time.
- Detect MIME by content and reject path traversal, links, active content, scripts, and unsupported encodings.
- Store immutable original hash and parser/policy version in restricted quarantine.
- Normalize display fields; classify memory-like content, prompt-like content, credentials, and PII separately.
- Never import credentials. Never activate provider/tool configuration from a card.
- Prompt-bearing fields are shown as untrusted legacy metadata and excluded from the system/developer instruction plane.
- Create a proposed CompanionIdentity version; Owner review and explicit field-level grants precede activation.
- Re-import is a diff against the active version, not an overwrite.

## Memory Firewall

Authorization precedes semantic retrieval. A vector similarity query must never search a superset and then rely on the model to ignore forbidden results.

Decision inputs:

- requester principal and authenticated Owner;
- acting Companion/Social Twin;
- purpose/reason code and channel;
- memory namespace/domain, subject, provenance, sensitivity, expiry;
- relationship and friendship state;
- explicit allow/deny grants and Owner safety controls;
- cumulative disclosure history for the recipient/topic.

Decision result is `ALLOW`, `DENY`, or `ALLOW_REDACTED`, with rule IDs, policy version, authorized field mask, retrieval ceiling, expiry, and audit trace. Only allowed IDs/domains enter vector/ranking queries. Returned text is minimized to the purpose; summaries do not inherit broader permission than their sources.

`Friendship` may satisfy a grantee predicate but never creates permission by itself. `Relationship` is semantic state, not an ACL. A blocked or paused relation invalidates cached grants immediately.

## Prompt and model isolation

- Maintain a registry of immutable prompt templates and allowed reason codes.
- Assemble messages from typed sections with provenance labels; external content is quoted/encoded as data.
- Exclude unnecessary identity and memory fields; use structured outputs with strict schemas.
- Disable arbitrary URL fetch, code execution, shell, database, and messaging tools in V0 runtime.
- Treat completion, tool arguments, citations, and model-generated memory proposals as untrusted until validated.
- Prompt-injection detectors can raise risk or block, but may not grant memory access or override deterministic controls.

## Output DLP and safety

The publication pipeline performs:

1. structural/schema validation and length/rate checks;
2. exact secret/canary detection for credentials, tokens, private IDs, and known private substrings;
3. PII detection using deterministic recognizers plus a benchmarked Presidio-compatible analyzer;
4. policy checks for abuse, sexual safety/age, coercion, self-harm, impersonation, and platform rules;
5. cumulative disclosure comparison for the recipient/topic;
6. allow, redact, require Owner review, or block;
7. SafetyEvent and sanitized AuditEvent creation.

Raw blocked content has the shortest feasible retention and a separate restricted access role. Normal telemetry records categories and hashes, not private payloads.

### V0 bounded Encounter enforcement

- The Encounter capability is expiring, mutually Owner-approved, and may transition only once from unused to claimed and then once from claimed to consumed.
- Preflight validates both Owner/Twin bindings and active Social Twin status before any retrieval or provider work.
- Input is length/credential/PII/injection scanned and remains explicitly typed `UNTRUSTED`; detector results can only restrict execution.
- Publication and Compute holds precede permission-gated memory retrieval. Only authorized IDs from the responder's `SOCIAL` namespace reach ranking or the provider context.
- Immediately before external provider I/O, an immutable private execution claim binds the invitation to one Compute and publication reservation. The database rejects social Compute `START` without that claim; terminal persistence later marks the invitation consumed.
- Invitation issuance is itself an authenticated Owner consent action. It freezes both active Social Twins, Persona and source Identity Passport versions, one-shot scope, expiry, purpose, and context hash. Only the authenticated responder may supply the second approval or reject; service-role code cannot impersonate either Owner. Consent evidence and database timestamps are immutable, and clients retain no direct table-write path.
- Provider usage outside its reserved envelope fails closed. Provider failure or blocked output settles a conservative/actual charge, releases publication capacity, and creates no Artifact or Life Event.
- A stale Encounter claim may release capacity only when no durable provider `START` exists. It still consumes the one-shot invitation and creates a claim-bound non-delivery fact. A started attempt is quarantined for reconciliation and can never be recovered as zero-cost.
- Operational discovery of stale starts is a bounded, service-only advisory scan. The worker exposes only claim identifiers and stable outcome/error classes; PostgreSQL revalidates Owner scope, evidence identity, terminal state, locks, and conservative settlement. Client roles cannot scan or reconcile, and no prompt, completion, memory, credential, or raw evidence is logged.
- Normal safety evidence is hash-only. Delivered artifacts contain only output that passed deterministic DLP, including PII redaction and private-canary/credential blocking.
- Life Events and Inbox items are Owner-only facts, not automatic Memory, identity, relationship, or publication writes.

## Authentication and authorization

- Supabase Auth issues identity; the API maps it to an active Owner and invitation state.
- V0 is 18+ and invitation-only. Age attestation and policy acceptance are versioned audit events; stronger verification is a later risk decision.
- RLS denies by default. Public views expose explicit projections, never base private tables.
- Sensitive actions—credential change/export, identity replacement, permission widening, account deletion—require recent authentication and may require step-up verification.
- Service-role database access is separated by runtime role; the social/public API role cannot select private memory content or credential ciphertext.
- Production Encounter orchestration accepts only the service-only PostgreSQL adapter. It records hash-only safety evidence, never retries a replayed execution claim, and never falls back to an in-memory authority. Any reservation, claim, or START persistence failure prevents Provider I/O.
- Encounter context is assembled only after a durable claim. PostgreSQL locks and verifies the approved Invitation and frozen identity versions before descriptor-first Memory authorization. Owner/private namespaces are structurally excluded; explicit deny overrides; friend-shareable records require an active purpose-bound grant. Only bounded presence markers or summaries enter the immutable private snapshot, while ledgers, receipts, logs, and errors retain only identifiers and hashes.
- Migrations remove PostgreSQL's global future-function `PUBLIC EXECUTE` default for the role that actually runs migrations. Schema-specific default ACLs cannot subtract that built-in global grant, so every future RPC is default-denied and must explicitly grant only its intended server or narrowly authenticated role. If deployment introduces another migration creator role, that role must run the same default-ACL migration rather than receiving a broad shared grant.
- All write APIs require idempotency keys and protect against replay; web cookie flows require CSRF protection.

## BYOK and provider privacy

- Store keys in a managed secret store or KMS-backed envelope encryption; database rows reference key versions.
- Display only provider, label, fingerprint suffix, creation/rotation timestamps, and validation state.
- Decrypt just in time inside the provider gateway; never send a key to the mobile client after creation.
- Declare per-provider data retention/training/residency capabilities and require Owner acknowledgment where relevant.
- Route the minimum authorized context. Embedding and moderation providers are also disclosure recipients and must be recorded.
- Rotation and deletion invalidate caches and scheduled jobs; failed decrypt is fail-closed.

## Security verification gates

CI and pre-release testing must include:

- cross-owner RLS/property tests for every table and storage bucket;
- imported card corpus with zip bombs, malformed PNG chunks, traversal, scripts, secrets, and prompt injection;
- private-memory canaries and multi-turn exfiltration suites;
- output redaction/block tests in supported languages;
- model/provider failure, timeout, retry, and partial-charge cases;
- idempotency/replay and budget-race tests;
- dependency/SBOM, secret, SAST, and migration-policy scans;
- export tests proving private memory, credentials, raw safety evidence, and other Owners' data are absent.

Production launch is blocked if any critical invariant lacks a deterministic test. Classifier metrics must be reported by language and policy class with false-positive/false-negative samples; “AI safety check enabled” is not evidence.

## Incident and deletion basics

Kill switches can pause a Companion, Social Twin publication, a provider/model, import processing, or an entire reason code. Revocation must prevent new retrieval/calls immediately, not wait for caches. Incidents preserve append-only minimal evidence, rotate affected secrets, identify all downstream provider disclosures from the audit/compute trace, and notify affected Owners under applicable policy/law.

Account and memory deletion use a tombstone workflow across primary rows, embeddings, blobs, caches, queued jobs, and derived summaries. Backups expire on a documented schedule; deletion receipts identify completed and pending surfaces without retaining deleted content.
