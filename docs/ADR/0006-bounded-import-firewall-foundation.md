# ADR-0006: Bounded JSON import before binary or archive formats

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

Companion portability requires external identity import, but cards, images, archives, lorebooks, URLs, and embedded metadata create different parser and decompression attack surfaces. Supporting them together would make it difficult to prove that untrusted instructions and credentials cannot cross into identity authority.

## Decision

The first executable import slice accepts only bounded UTF-8 JSON Character Card V2 and a limited legacy JSON object. It parses into quarantine, recursively classifies risky content, exposes only sanitized findings and typed identity candidates, and requires explicit Owner field approval. Prompt-bearing legacy fields remain inert source evidence. Re-import creates a new identity version.

PNG cards, archives, URL fetching, media metadata, lorebook activation, provider configuration, and tool configuration are rejected or excluded until separately bounded parsers and adversarial corpora exist.

## Consequences

The first portability path is narrower but deterministic and testable. Some users must export a JSON card before import. Format adapters can be added behind the same quarantine contract without changing CompanionIdentity or approval semantics.

## Security and privacy

Raw payloads remain in a restricted schema. Public review DTOs contain hashes and redacted previews, not raw credentials or PII. Unknown and nested fields do not acquire authority. Approval cannot create Social Runtime, memory, provider, or tool permissions.

## Portability and reversal

The normalized draft and source manifest are format-neutral. New format adapters may be added without migrating approved identities. Removing an adapter leaves canonical identity versions and passports intact.

## Constitution impact

Implements the Import Firewall, identity versioning, least-authority, and portability invariants; no principle is amended.
