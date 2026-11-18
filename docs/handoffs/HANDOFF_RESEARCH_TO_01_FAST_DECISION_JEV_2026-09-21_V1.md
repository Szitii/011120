# HANDOFF — Fast Decision Layer / Jev Architecture Research → 01 Founder Office

**Handoff ID:** RESEARCH-01-FAST-DECISION-JEV-2026-09-21-V1  
**Sender:** Research / Intelligence  
**Receiver:** 01 Founder Office  
**Status:** READY FOR FOUNDER REVIEW  
**Engineering baseline:** `main@be68da4ad2753c475f6c7d0e3a0655f1f606cfbe`

## Decision requested

Decide whether to authorize a **time-boxed isolated benchmark spike** for a provider-agnostic Fast Decision Layer.

This handoff does **not** request:
- Jev adoption;
- a Stage 1 implementation;
- changes to 02×03 current work;
- product-direction changes;
- replacing deterministic Memory Permission / authorization;
- production provider integration.

## Research finding

COMPANION_SOCIAL likely needs a fast-decision **capability**, but not necessarily a dedicated Jev layer.

Recommended architecture:
`deterministic rules -> fuzzy fast decision signal -> confidence gate -> stronger model/escalation`.

Jev is a credible candidate for the fuzzy decision tier because it is optimized for typed probabilistic decisions, low latency and low input cost. Independent evidence shows strong economics but mixed task accuracy/calibration. The most encouraging evidence is decomposition: several cheap probabilistic signals composed in code can outperform a single model verdict.

Therefore Jev should be treated as a replaceable implementation behind an internal DecisionEngine contract, never as product semantics.

## Hard boundaries

1. Deterministic policy remains authoritative for Memory permissions, Owner authorization, budgets, legal/financial actions, publication permission and hard safety invariants.
2. External decision providers receive minimum derived state; no private-memory expansion.
3. Fallback may not widen context or permissions.
4. Every decision engine is versioned and observable.
5. No Jev-specific type enters durable domain schema.
6. Current 02×03 execution is not interrupted.

## Proposed isolated spike, only if approved

Time-box: 0.5–1 engineering day for harness/fixtures only, followed by benchmark runs when credentials are available.

Compare:
- deterministic rules/heuristics;
- small structured LLM/classifier;
- Jev direct;
- stronger reference model.

Initial task families:
Encounter micro-decision, Life Event candidate, Social Memory candidate, routing/escalation, notification/feed ranking.

Output:
- reproducible DecisionBench;
- p50/p95/p99 latency and cost;
- accuracy/F1/AUROC where applicable;
- Brier/ECE + selective-risk curve;
- stability and failure/fallback results;
- privacy eligibility matrix;
- recommendation: NO LAYER / RULES ONLY / HYBRID / DECISION MODEL CANDIDATE.

## Founder Office recommendation

**Research recommendation: authorize the isolated benchmark when it does not contend with 02×03. Do not authorize production integration or a Jev-selecting ADR yet.**

Only after COMPANION_SOCIAL-specific evidence shows material frontier improvement should 01 hand off to 02 for a provider-neutral ADR and isolated technical spike.

Full research: `docs/research/FAST_DECISION_LAYER_JEV_ARCHITECTURE_RESEARCH_2026-09-21.md`.
