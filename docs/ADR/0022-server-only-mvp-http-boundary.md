# ADR 0022: Server-only MVP HTTP boundary

Status: Accepted

## Decision

Expose a framework-neutral, versioned `/v0` boundary whose authenticated session resolver supplies the Owner-scoped port and whose service-only Encounter port is injected separately. Client requests never carry authoritative Owner identity, Persona, private Memory, provider prompt, credentials, or policy evidence.

Implemented routes delegate to existing PostgreSQL commands and the persistent Encounter orchestrator. Planned MVP reads return a safe capability-unavailable problem until an authorized persistence adapter exists; the production boundary must not fall back to in-memory repositories or dual writes.

The error envelope contains a stable code, message class, retry hint, and trace ID. It never serializes underlying exceptions. Resource names remain independent of navigation labels.

## Consequences

- Authentication, capability derivation and protected resources are re-evaluated server-side.
- Invitation, Memory, Social Twin, context manifest, idempotency, safety and database transaction invariants remain authoritative.
- App work can bind to OpenAPI `0.2.0` while distinguishing implemented and contract-only resources.
- HTTP framework/Auth-provider composition, missing authorized reads, rate limiting, and production deployment remain explicit work.

