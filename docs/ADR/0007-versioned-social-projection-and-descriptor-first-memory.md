# ADR-0007: Versioned allowlist projection and descriptor-first memory retrieval

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

The private Companion and Social Twin are separate security principals. Copying a full identity into the social runtime or retrieving a mixed memory pool before filtering would turn that distinction into a prompt convention rather than an enforceable boundary.

## Decision

An Owner creates each SocialPersona version by selecting allowlisted source-to-public field mappings from the current approved CompanionIdentity. The projection records source value hashes and identity provenance but does not embed the private identity document. A stable SocialTwin principal points to one active immutable SocialPersona and one SOCIAL-only memory namespace.

Memory access is descriptor-first. The Permission Gate selects Owner, Companion, namespace, domain, principal, purpose, expiry, and explicit grant/deny rules before any content or semantic ranking call. Only authorized memory IDs and their maximum disclosure levels may enter search. Deny overrides allow; missing allow denies non-public memory.

## Consequences

Owners must deliberately choose public fields and may create new persona versions as identity evolves. Search adapters must support authorized-ID or prefiltered-namespace queries. The platform gains explainable access receipts and can replace vector technology without moving permission ownership.

## Security and privacy

Private identity, private memory, imported prompts, and credentials never enter SocialRuntimeView. Database schemas prevent PRIVATE domains from being labeled SOCIAL. SocialPersona and decision receipts are immutable, and direct authenticated-client writes are revoked.

## Portability and reversal

Social personas and private identities export independently with provenance links. Projection mappings or retrieval engines may change in future versions without collapsing principals or widening old grants.

## Constitution impact

Implements the Memory Firewall and Private Companion/Social Twin split; no principle is amended.
