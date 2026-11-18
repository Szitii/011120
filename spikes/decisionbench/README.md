# DecisionBench isolated spike

DecisionBench is an offline/provider-neutral benchmark harness for the Fast Decision Layer research.

It is intentionally isolated from Stage 1 runtime code. It does not:
- change Memory Permission, Owner authorization, budgets, publication, identity or safety semantics;
- add migrations or durable domain types;
- call production traffic;
- define unresolved Feed, DM or Life Simulation product semantics.

## Run

```bash
npm run decisionbench
```

The default benchmark compares:
- deterministic rules / heuristics;
- an offline probabilistic signal classifier.

External providers are represented only by the provider-neutral interface in this spike. Jev and stronger-model runs are reported as unavailable unless credentials/adapters are explicitly supplied in a later benchmark run.

The generated fixture set contains at least 200 cases per task family and includes Chinese, English, mixed-language, ambiguous and prompt-injection variants. These are benchmark fixtures, not production user labels, so architectural conclusions must remain provisional.
