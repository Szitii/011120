# ADR-0001: Domain-first modular monolith; no product fork

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

Reviewed Companion products and social apps solve useful adjacent problems but encode local single-user chat, human social accounts, federation, or product-specific servers. None owns CompanionIdentity, SocialTwin, permissioned memory, and compute attribution as one coherent domain. Forking one would make its assumptions expensive defaults.

## Decision

Build a TypeScript API-first modular monolith with explicit module ownership and PostgreSQL as canonical state. Use one worker and a transactional outbox. Do not fork an existing full product as the Companion Social Platform base.

## Consequences

Initial product code is smaller and domain concepts remain explicit. We must implement core schemas and APIs ourselves, but may selectively consume permissive libraries and patterns. Module interfaces and database roles create future service-extraction paths without paying microservice cost now.

## Security and privacy

Central transactions make Owner scoping, permission decisions, audit, and compute reservation easier to verify. Module-local table ownership reduces accidental private/social joins.

## Portability and reversal

OpenAPI and PostgreSQL keep clients and data portable. A module may be extracted when measured scale or isolation requires it. Adopting a full upstream product later would require a migration ADR and proof that Constitution invariants remain enforceable.

## Constitution impact

Implements the Constitution; no principle is amended.
