# ADR-0003: Private Companion/Social Twin split and permission-first retrieval

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

Many agent systems treat all character memory as one retrieval pool and rely on prompting to avoid disclosure. In a multi-owner social environment, similarity search over forbidden content is already an unnecessary exposure and makes multi-turn extraction likely. Friendship and relationship scores do not equal consent.

## Decision

Model Private Companion and SocialTwin as separate runtime principals joined through a versioned SocialPersona projection. Store memory namespace/domain and provenance explicitly. Evaluate MemoryPermission before candidate retrieval; only authorized IDs/domains enter ranking. Deny overrides allow. All social input and model output remain untrusted.

## Consequences

Some memories and summaries are duplicated as explicitly approved social projections, with provenance linking rather than implicit sharing. Product UX must explain denied/redacted decisions. Memory engines remain replaceable because permissions live in our domain.

## Security and privacy

This is the primary Memory Firewall boundary. Cross-owner RLS, purpose-bound grants, disclosure history, output DLP, and export canaries are mandatory tests. Friendship never grants memory access automatically.

## Portability and reversal

The domain can export identity and public/social projection separately from private memories. Collapsing the principals later would be destructive and would require a Constitution amendment; the intended reversal path is therefore to change projection UX, not remove the boundary.

## Constitution impact

Directly codifies a non-negotiable Constitution principle.
