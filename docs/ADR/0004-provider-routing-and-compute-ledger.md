# ADR-0004: Internal provider contract and immutable compute ledger

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

BYOK and multi-provider routing are useful but gateways do not know Companion Social Platform ownership, purpose, memory policy, publication policy, or who should pay. Unattributed background calls create both trust and unit-economic failures.

## Decision

All model-related work enters an internal RuntimeInvocation contract with Owner, Companion, reason, model, limits, policies, and billing party. Reserve budget before calls and append immutable ComputeTransaction entries per attempt. Begin with one or two direct adapters or an isolated, pinned LiteLLM-compatible gateway; canonical accounting stays in Companion Social Platform.

## Consequences

Provider changes do not alter product semantics. The team must maintain price tables, reconciliation, idempotency, and user-visible receipts. Activity, generation, publication, and platform-safety budgets are distinct.

## Security and privacy

Credentials live in a secret manager or vetted envelope encryption and are decrypted only in the gateway. Fallback cannot widen disclosed context. Provider calls are traceable for incidents without storing prompts in the cost ledger.

## Portability and reversal

Adapters can be replaced independently. Historical ledger entries preserve exact provider/model/pricing versions. A managed gateway can be added or removed without migrating identity or billing truth.

## Constitution impact

Implements the Compute rules; no principle is amended.
