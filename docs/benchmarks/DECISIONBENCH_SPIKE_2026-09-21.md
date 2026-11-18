# DecisionBench Isolated Spike — Evidence Report

**Date:** 2026-09-21  
**Scope:** isolated offline/provider-neutral spike only  
**Canonical approval:** `HANDOFF_01_TO_02_FAST_DECISION_DECISIONBENCH_2026-09-21_V1.md`

## Result

Recommendation: **RULES ONLY for the currently benchmarked fixture set**.

This is **not** a conclusion that probabilistic decision models are unnecessary in COMPANION_SOCIAL. It means the current spike does not yet provide evidence strong enough to promote Jev or any other decision model into a production candidate layer.

## Harness

The isolated harness lives under `spikes/decisionbench/` and contains:

- provider-neutral `DecisionEngine` interface;
- deterministic rules baseline;
- offline probabilistic signal-classifier baseline;
- unavailable placeholders for Jev direct and stronger-model reference when credentials are absent;
- 5 task families × 240 fixtures = 1,200 fixtures;
- Chinese / English / mixed-language variants;
- ambiguous and prompt-injection/adversarial variants;
- privacy eligibility metadata;
- metrics for accuracy/F1/AUROC, Brier, ECE, selective risk/coverage, repeatability, cost and latency.

No Stage 1 Runtime, migrations, UI, product behavior, Memory Permission semantics, Owner authorization or production provider path was changed.

## Measured local evidence

The committed formulas/fixture definitions were mirrored locally for a reproducible offline measurement because GitHub-hosted jobs are currently failing before runner steps start (see CI note below).

### Aggregate

| Engine | Accuracy | F1 | AUROC | Brier | ECE | Coverage | Selective risk |
|---|---:|---:|---:|---:|---:|---:|---:|
| deterministic rules v1 | 1.0000 | 1.0000 | 1.0000 | 0.0474 | 0.1665 | 0.9000 | 0.0000 |
| offline signal classifier v1 | 0.8933 | 0.8991 | 0.9895 | 0.0792 | 0.0721 | 0.8500 | 0.0588 |

### Signal classifier by family

| Family | Accuracy | F1 | Brier | ECE | Coverage | Selective risk |
|---|---:|---:|---:|---:|---:|---:|
| Encounter | 0.8750 | 0.8571 | 0.0817 | 0.2154 | 0.7500 | 0.0000 |
| Life Event | 0.8417 | 0.8633 | 0.0895 | 0.1477 | 0.8750 | 0.1429 |
| Social Memory candidate | 1.0000 | 1.0000 | 0.0497 | 0.1915 | 1.0000 | 0.0000 |
| Routing / escalation | 0.8750 | 0.8889 | 0.1254 | 0.2106 | 0.7500 | 0.1667 |
| Notification ranking | 0.8750 | 0.8889 | 0.0495 | 0.1629 | 0.8750 | 0.0000 |

Offline compute latency is sub-millisecond for both baselines and cost is zero; these values are not comparable to networked model/provider latency and should not be used as a Jev latency claim.

## Interpretation

The current fixture set is synthetic/curated and partly feature-shaped. The perfect deterministic-rules score is therefore a warning about benchmark construction, not proof that deterministic rules solve all fuzzy production cases.

What the spike supports:

1. deterministic authority remains the correct default for permission, budget, hard safety and explicit invariants;
2. confidence-based abstention/escalation is measurable and useful as an interface concept;
3. provider-neutral decision receipts/metrics can be benchmarked without touching production Runtime;
4. Owner-private Social Memory remains ineligible for an external decision provider in this spike;
5. no external model may grant or widen Memory permission.

What the spike does **not** support:

- Jev adoption;
- Jev vs structured-LLM frontier claims;
- a production Decision Provider;
- provider-specific durable schemas;
- routing production traffic through a decision model.

## Provider availability

No Jev credential and no stronger-reference-model credential were available to this execution. Their benchmark rows are therefore intentionally unavailable rather than simulated.

A vendor/model comparison requires a later run with credentials and COMPANION_SOCIAL-labelled fixtures.

## Privacy / fallback evidence

- deterministic rules: public/social derived state eligible; Owner-private state remains local-only;
- external provider: minimum derived state only after vendor review; Owner-private input ineligible in this spike;
- safe fallback: abstain or existing deterministic semantics only;
- fallback may never widen context, permissions or publication rights.

## CI note

GitHub Actions runs created for this spike failed before any job step started; the same immediate runner-start failure is also present on several preceding documentation-only commits. Therefore no green GitHub-hosted benchmark run is claimed.

Relevant failed runs:
- DecisionBench workflow: `35556546287`
- foundation-checks: `35556546289`

This is treated as an execution-infrastructure gap, not benchmark evidence.

## ADR recommendation

**Worth entering ADR: yes, narrowly.**

The ADR should freeze only the architecture principle:

> deterministic policy owns authority; probabilistic decision engines may supply typed signals; confidence controls abstention/escalation; external providers receive minimum derived state; fallback never widens permissions; providers remain replaceable.

**Not warranted:** any ADR selecting Jev, a specific model, threshold, vendor, or production Decision Provider.

Before a provider-selection ADR:
- collect production-like COMPANION_SOCIAL labels;
- include at least 200 labelled examples per family and 1,000+ for high-impact privacy/safety classification;
- run Jev direct + structured small model + stronger reference;
- measure real p50/p95/p99 from intended deployment region;
- validate calibration/selective risk under language/style/distribution shift;
- complete vendor privacy/retention/DPA review.

## Final spike status

`ISOLATED DECISIONBENCH COMPLETE — PROVIDER EVIDENCE INSUFFICIENT FOR ADOPTION`
