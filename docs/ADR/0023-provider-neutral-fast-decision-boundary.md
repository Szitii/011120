# ADR-0023: Provider-neutral Fast Decision boundary

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

COMPANION_SOCIAL has candidate workloads that may benefit from fast, typed, low-cost decisions before expensive generation: Encounter micro-decisions, Life Event candidacy, Social Memory candidacy, provider/model routing, Compute escalation, and selected ranking signals.

The isolated DecisionBench spike established a useful architecture boundary but did not establish a production provider choice. Its current fixture set is synthetic/curated and partly feature-shaped. Deterministic rules scored perfectly on that fixture set; this is not evidence of universal superiority on production fuzzy tasks. Jev and stronger-reference providers were not benchmarked because credentials were unavailable. GitHub-hosted spike workflows also failed before job steps began, so the spike does not claim green hosted CI.

Current evidence therefore supports a narrow provider-neutral architecture principle, not provider adoption or production implementation.

## Decision

COMPANION_SOCIAL adopts a provider-neutral **DecisionPolicy / DecisionEngine boundary** for future use, subject to these rules:

1. **Deterministic policy owns authority.** Permissions, Memory disclosure, Owner authorization, budgets, hard safety invariants, publication eligibility, legal/financial authority, and other explicit invariants remain deterministic and authoritative.
2. **Decision engines may supply typed signals only.** Probabilistic outputs may help with fuzzy, high-volume, reversible decisions but do not become product truth by themselves.
3. **Confidence controls abstention and escalation.** Low-confidence or unavailable results must abstain, defer, or escalate to an approved stronger path. Safe failure is preferred to speculative action.
4. **Minimum derived state only.** External decision providers receive only the minimum task-appropriate derived state. Owner-private Memory is not eligible merely because a decision model could consume it.
5. **Fallback never widens authority.** Provider failure or fallback may never expand context, permissions, disclosure, publication rights, budget, or action authority.
6. **Providers remain replaceable.** Rules-only engines, local classifiers, structured small-model adapters, Jev-like providers, and stronger-model escalation may sit behind the same internal boundary without domain migration.
7. **Provider/model identity is operational, not semantic.** No vendor/model-specific type, threshold, API shape, or version becomes durable product semantics.
8. **Decision observability is mandatory.** A future production implementation must be able to record, without unnecessary sensitive payloads:
   - decision / trace ID;
   - reason / surface;
   - state-schema and policy version;
   - engine/provider/model exact version when applicable;
   - question/rubric version when applicable;
   - probabilities/confidence;
   - abstention/escalation/fallback path;
   - latency;
   - estimated/actual cost;
   - downstream outcome when observable.
9. **Candidate signals are not authority.** A decision result alone may not create Memory truth, identity truth, relationship truth, publication permission, or legal/financial authority.

## Non-decisions

This ADR does **not** select or approve:

- Jev;
- any provider or model;
- production thresholds;
- production routing traffic;
- provider-specific durable schemas;
- a production Decision Provider;
- changes to Memory Permission;
- Life Simulation or Trigger Engine;
- full Feed/DM semantics;
- continuous-agent behavior;
- any new Stage 1 product behavior.

## Consequences

### Positive

- Fast-decision experiments can evolve without coupling product semantics to a vendor.
- Safety-critical and authorization behavior remains inspectable and deterministic.
- Confidence-based abstention gives fuzzy classifiers a bounded role.
- Future provider comparisons can share one benchmark/receipt shape.
- Rules-only implementations remain first-class rather than a temporary fallback.

### Costs

- Engineering must maintain a clear separation between policy authority and probabilistic signals.
- Calibration, thresholds, provider health, privacy eligibility, and fallback behavior require explicit evidence before production use.
- A provider-neutral abstraction adds little value if the product never develops a fuzzy decision workload that rules cannot handle; therefore no production implementation is justified by this ADR alone.

## Security and privacy impact

- Deterministic Memory Permission and deny-overrides-allow remain authoritative.
- A decision engine may classify risk/sensitivity or provide candidate signals, but cannot grant access.
- External providers are limited to minimum derived state and may not receive Owner-private Memory by default.
- Safe fallback is abstention or existing deterministic semantics.
- Logs/receipts must avoid raw sensitive payloads unless separately justified and approved.

## Portability impact

The boundary explicitly allows:

- rules-only engines;
- local conventional classifiers;
- structured small-model adapters;
- future Jev-like providers;
- stronger-model escalation.

Any of these may be added, replaced, or removed without changing durable domain semantics. A provider-specific migration is a design failure unless separately approved by a future ADR.

## Evidence and limits

The DecisionBench spike currently supports architecture separation, not provider selection.

Evidence limitations:

- fixtures are synthetic/curated and partly feature-shaped;
- deterministic rules scored perfectly on the current fixture set, which is not proof of universal superiority;
- Jev and stronger-reference providers were not run because credentials were unavailable;
- hosted CI for the spike was not green because workflows failed before job steps began;
- offline latency/cost measurements are not comparable to real network-provider latency/cost.

Before any provider-selection ADR, COMPANION_SOCIAL requires:

- production-like COMPANION_SOCIAL-labelled data;
- real provider runs including at least a structured small-model baseline and stronger reference;
- p50/p95/p99 latency from the intended deployment region;
- calibration and selective-risk evidence under language/style/distribution shift;
- vendor privacy, retention, DPA/subprocessor, security, and deletion review.

## Reversal and evolution plan

This ADR can be satisfied by doing nothing beyond rules until better evidence exists.

A future implementation may start with a local or rules-only engine behind the boundary. A later provider-selection ADR may approve a specific adapter only after the evidence gates above are met.

If future evidence shows that the boundary adds complexity without measurable benefit, the DecisionEngine abstraction may be removed while retaining deterministic policy authority and observability principles. No domain migration should be required.

## Constitution implications

No Constitution principle is amended.

This ADR operationalizes existing principles:

- deterministic policy remains authoritative for permissions and hard constraints;
- the smallest capable mechanism should handle bounded classification/routing work;
- stronger models are reserved for identity-bearing reasoning/expression when materially valuable;
- fallback may not widen context;
- provider/model implementations remain replaceable;
- compute and decision work must remain attributable and observable.

## Implementation status

**No production implementation is approved or justified now.**

The current benchmark recommendation remains **RULES ONLY** for the measured fixture set. Continue implementation only after a concrete fuzzy-decision workload shows rules are insufficient and later evidence satisfies the provider/model/privacy gates above.
