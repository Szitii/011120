# Fast Decision Layer / Jev Architecture Research

**Date:** 2026-09-21  
**Status:** Architecture research only — no Stage 1 implementation  
**Scope:** provider-agnostic Fast Decision Layer candidate analysis  
**Current engineering baseline:** main `be68da4ad2753c475f6c7d0e3a0655f1f606cfbe`

## Executive conclusion

COMPANION_SOCIAL has a real architectural need for a **fast-decision capability**, but the evidence does **not** support making Jev a mandatory architectural layer or making every micro-decision an AI call.

The correct abstraction is a provider-agnostic **DecisionPolicy / DecisionEngine boundary** with an escalation ladder:

1. deterministic policy/rules where semantics are explicit or safety-critical;
2. cheap structured classifier / small decision model for fuzzy, high-volume, reversible judgments;
3. stronger generative/reasoning model only when identity-bearing interpretation or ambiguous reasoning is materially valuable;
4. abstain / defer / human or deterministic fallback when confidence or provider health is insufficient.

Jev is a credible candidate implementation for tier 2 and merits an **isolated benchmark spike only after 01 approval**. It must remain behind the internal contract and must not become product semantics.

## Why this fits the current Constitution and code

Existing COMPANION_SOCIAL rules already say:
- deterministic state and small computations should handle clocks, cooldowns, relationship thresholds, candidate filtering, notification aggregation and budget checks;
- the smallest capable model should handle classification/extraction;
- stronger models are reserved for identity-bearing expression;
- provider/model selection must remain replaceable and attributed;
- fallback may not widen disclosed context;
- Memory Permission Gate is a policy boundary and deny-overrides-allow.

Therefore this research proposes no product-direction change. It names an implementation class for a gap that the Compute Model already anticipates.

## Current main observations

At `be68da4`, the code already has:
- immutable compute attribution and reason registry;
- provider/model routing concepts;
- bounded Encounter execution;
- deterministic Memory Permission Gate before retrieval;
- safety scanning around Encounter input/output;
- owner-scoped Life/World/Profile semantics;
- no independent fast-decision provider abstraction yet.

Important: Memory Permission Gate currently embodies authorization semantics. A probabilistic model must never replace deterministic grants, domain boundaries, deny-overrides-allow, owner authorization, budget ceilings, or publication permissions.

## Does COMPANION_SOCIAL need a separate Fast Decision Layer?

**Capability: yes. Dedicated vendor/service: not yet proven.**

The strongest candidate workloads are fuzzy decisions that are:
- high-frequency;
- low-to-moderate consequence;
- typed/finite-output;
- cheap to verify or safe to abstain;
- useful before expensive generation;
- measurable against labelled fixtures.

Good candidates:
- Encounter candidate relevance / micro-decision signals;
- Life Event candidate scoring;
- Social Memory candidate scoring (candidate only, never authorization);
- provider/model routing signals;
- compute escalation;
- notification/feed/recommendation ranking features;
- Agent-to-Agent micro-decision signals.

Conditional candidate:
- Memory Permission **pre-classification** only, e.g. classify requested purpose/risk/sensitivity before deterministic policy. It must not grant access.

Poor candidates:
- final authorization;
- legal/financial consent;
- irreversible safety enforcement without deterministic guardrails;
- Companion identity/persona changes;
- final memory disclosure;
- identity-bearing free-form expression.

## Jev evidence

TypeSafe launched Jev on 2026-09-15 as a System One model: state + typed questions -> Choice / Score / Noul probabilities. Vendor docs report $0.042/M input tokens, free output, parallel independent questions, and roughly 70–500 ms end-to-end. The vendor explicitly says its largest 193.6x speed / 444.6x cost gains are at the high end of expected real-world gains and acknowledges evaluation bias.

Independent evidence is mixed and useful:
- WallerChen/jev-measured observed roughly $0.000015–$0.000023 per several-hundred-token decision, direct first-party p50 around 313 ms vs OpenRouter p50 734 ms in one interleaved route test, and 1/3/4/5 questions with server times ~70/72/81/74 ms.
- The same study found strict JSON schema removed all observed type violations from the compared chat models; therefore type reliability alone is **not** a sufficient reason to adopt Jev.
- On 27 labelled support tickets Jev tied Mistral Small (27/27); the sample is too small to establish general superiority.
- anisselbd/jev-phishing-bench on 2,000 emails found Jev's direct verdict materially worse than Claude Haiku 4.5 (62.6% vs 81.3%; ECE 0.154 vs 0.097), while Jev was faster/cheaper. Critically, decomposing the task into five Jev signals and combining them in code/logistic regression reached ~95% accuracy and ECE ~0.027 on the reported split. This supports "Jev as signal generator + code-owned policy" more than "Jev as final authority."

## Latency

Vendor: 70–500 ms, West-Coast-hosted service.

Independent results show network location matters materially. First-party routing can be substantially faster than a gateway; OpenRouter added a large tail in one reproducible test. COMPANION_SOCIAL must benchmark from its intended deployment region and report:
- client wall-clock p50/p95/p99;
- network floor;
- provider server time when exposed;
- cold/warm behavior;
- concurrency saturation;
- direct vs gateway route.

A sub-500ms median is plausible. A production p95 suitable for every real-time interaction is not yet proven for COMPANION_SOCIAL.

## Cost

At $0.042/M input tokens, short decision calls are extremely cheap. However, small structured LLMs can be close in cost on short single-question workloads. The economic advantage becomes stronger when many independent questions share the same state because Jev evaluates them in parallel and output is not token-billed.

Cost must be measured as:
`cost per 1,000 decisions`, `cost per meaningful Companion event`, and `avoided expensive generation cost`.

## Decision quality and calibration

Do not benchmark only raw accuracy. For COMPANION_SOCIAL the important question is whether confidence can safely control escalation.

Required metrics:
- accuracy/F1/AUROC where labels exist;
- Brier score and ECE;
- reliability diagram;
- selective risk / coverage curve;
- false-allow and false-block separately;
- confidence on ambiguous/adversarial fixtures;
- repeatability across identical calls;
- distribution drift by language and Companion style.

The phishing benchmark is a warning: Jev confidence is not automatically well calibrated for every domain. Calibration must be validated on COMPANION_SOCIAL-labelled data.

## Privacy / security

TypeSafe's privacy policy says it collects service Inputs, does not train/fine-tune models on prompts/Input, and does not disclose Input except to service providers. It retains personal data as reasonably necessary for services/business purposes. This is insufficient by itself for sensitive COMPANION_SOCIAL memory.

Requirements before any sensitive production use:
- DPA / enterprise terms;
- explicit retention/deletion window;
- subprocessors;
- region/residency;
- encryption and incident response;
- whether provider logs raw Input;
- contractual no-training/no-secondary-use;
- deletion/export process;
- security certifications if available.

Until verified, Jev must receive only the **minimum derived state** needed for a decision. It should not receive Owner-private memory for routing/ranking tasks.

Security rule: no external decision model may broaden a Memory Firewall permission. It may only produce a risk/sensitivity signal consumed by deterministic policy.

## Vendor lock-in / fallback

Risk is currently meaningful:
- Jev is new and closed-weight;
- API semantics are specialized;
- version aliases can move;
- direct and OpenRouter routes differ;
- long-term pricing/SLA is unproven;
- no evidence yet that COMPANION_SOCIAL-specific quality survives future model updates.

Mitigation:
- internal provider-neutral schema;
- no Jev-specific types in domain objects;
- pin exact model versions for benchmarks/production;
- log decision-engine version, question/policy version, latency, confidence and outcome;
- deterministic safe fallback;
- structured-LLM adapter as alternate implementation;
- shadow evaluation before switching providers.

## Observability contract

Every AI-assisted decision should emit a receipt separate from expressive generation:
- decision_id / trace_id;
- reason_code / surface;
- state_schema_version and state hash (not raw sensitive payload);
- decision_policy_version;
- engine/provider/model exact version;
- question/rubric version;
- output probabilities/confidence;
- threshold/escalation decision;
- latency;
- estimated/actual cost;
- fallback path;
- final downstream outcome when observable.

This can reuse Compute attribution principles without forcing decision payloads into the billing ledger.

## Alternatives

### Deterministic rules
Best default for permissions, budgets, hard safety constraints, cooldowns, explicit relationship thresholds, eligibility and invariants. Fastest, cheapest, inspectable, offline. Weak on fuzzy semantics and rapidly growing exception sets.

### Small structured LLM / classifier
Use strict schema, temperature 0 where supported, and a pinned prompt/model. Strong baseline because independent Jev testing shows structured output eliminates the naive "LLMs break types" argument. More portable than Jev and can reason/generate when needed, but usually slower/costlier and native confidence is weaker.

### Trained conventional classifier / ranking model
Best when COMPANION_SOCIAL accumulates stable labelled data and task definitions. Very cheap, self-hostable, auditable and calibratable. Requires dataset/ML lifecycle and can degrade under distribution shift.

### Embedding / heuristic ranking
Good for feed/recommendation candidate generation and similarity; should often precede any model call.

## Recommended benchmark

Do not benchmark one generic "Fast Decision" task. Build a COMPANION_SOCIAL DecisionBench with 6 task families:

1. Encounter candidate: proceed / defer / reject + interest/risk signals.
2. Life Event candidate: relevance/novelty/meaningfulness scores.
3. Social Memory candidate: store-candidate / ignore + sensitivity signal; deterministic gate remains authoritative.
4. Provider/model routing: deterministic fixture with known capability/privacy/cost constraints plus fuzzy complexity signal.
5. Compute escalation: rules-only vs decision model on "needs strong model?".
6. Notification/feed ranking: pairwise or small-list ranking against human/owner preference labels.

For each family use at least 200 labelled fixtures before architectural conclusions; target 1,000+ for high-impact safety/privacy classification. Include:
- clear positives/negatives;
- deliberately ambiguous cases;
- adversarial/prompt-injection text;
- Chinese + English + mixed-language;
- long/short states;
- multiple Companion voices;
- distribution-shift holdout.

Compare:
A. deterministic rules / heuristics;
B. cheap structured LLM/classifier with strict schema and deterministic sampling where possible;
C. Jev direct API;
D. Jev via gateway only as an operational comparison, not a separate quality model;
E. stronger model as reference/escalation, not default.

Measure p50/p95/p99 latency, cost, accuracy/F1/AUROC, ECE/Brier, selective risk/coverage, stability, availability, and privacy eligibility.

Decision rule for an isolated 02 Spike:
- Jev or another decision model must materially improve the latency-cost-quality frontier on **COMPANION_SOCIAL fixtures**, not vendor demos;
- calibration must support a useful abstention/escalation threshold;
- safe fallback must preserve product semantics;
- no sensitive-context expansion;
- adapter must be replaceable without domain migration.

## Recommendation to 01

**Approve architecture research result; do not adopt Jev yet.**

Recommended next action is an **isolated benchmark spike**, not an ADR selecting Jev and not Stage 1 integration. 02 should receive it only if Founder Office agrees that the benchmark can run without interrupting the current 02×03 execution unit.

If run, the spike should implement only a provider-neutral DecisionEngine harness and offline fixtures. No production path, migrations, UI, product behavior, or Memory Permission semantics change.

**Working architecture principle:**  
> Deterministic policy owns authority. Fast decision models supply probabilistic signals. Generative models own identity-bearing reasoning/expression. Confidence controls escalation; providers remain replaceable.
