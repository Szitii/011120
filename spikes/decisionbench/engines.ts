import { performance } from "node:perf_hooks";
import type { DecisionEngine, DecisionFixture, DecisionResult } from "./types.ts";

function clamp(x: number): number { return Math.max(0.001, Math.min(0.999, x)); }
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

function probabilityForRules(fixture: DecisionFixture): number {
  const f = fixture.features;
  switch (fixture.family) {
    case "ENCOUNTER":
      if ((f.cooldown ?? 0) > 0 || (f.unavailable ?? 0) > 0 || (f.risk ?? 0) >= .8) return .02;
      return clamp(((f.relevance ?? 0) * .6) + ((f.reciprocity ?? 0) * .4) - ((f.risk ?? 0) * .7));
    case "LIFE_EVENT":
      return clamp(((f.novelty ?? 0) * .48) + ((f.meaning ?? 0) * .62) - ((f.duplication ?? 0) * .75));
    case "SOCIAL_MEMORY":
      if (fixture.privacy === "OWNER_PRIVATE" || (f.sensitivity ?? 0) >= .8) return .01;
      return clamp(((f.utility ?? 0) * .9) - ((f.sensitivity ?? 0) * .7) - ((f.repetition ?? 0) * .25));
    case "ROUTING":
      if ((f.deterministic ?? 0) > 0) return .01;
      return clamp(((f.complexity ?? 0) * .38) + ((f.ambiguity ?? 0) * .42) + ((f.consequence ?? 0) * .36));
    case "NOTIFICATION":
      return clamp(((f.relevance ?? 0) * .58) + ((f.urgency ?? 0) * .45) - ((f.fatigue ?? 0) * .65));
  }
}

function probabilityForSignalClassifier(fixture: DecisionFixture): number {
  const f = fixture.features;
  let z = -1.4;
  switch (fixture.family) {
    case "ENCOUNTER":
      z += 3.1 * (f.relevance ?? 0) + 2.4 * (f.reciprocity ?? 0) - 4.8 * (f.risk ?? 0) - 5 * (f.cooldown ?? 0) - 4 * (f.unavailable ?? 0);
      break;
    case "LIFE_EVENT":
      z += 2.6 * (f.novelty ?? 0) + 3.2 * (f.meaning ?? 0) - 3.6 * (f.duplication ?? 0);
      break;
    case "SOCIAL_MEMORY":
      z += 3.6 * (f.utility ?? 0) - 4.5 * (f.sensitivity ?? 0) - 1.4 * (f.repetition ?? 0);
      if (fixture.privacy === "OWNER_PRIVATE") z -= 8;
      break;
    case "ROUTING":
      z += 2.2 * (f.complexity ?? 0) + 2.7 * (f.ambiguity ?? 0) + 2.8 * (f.consequence ?? 0) - 5.5 * (f.deterministic ?? 0);
      break;
    case "NOTIFICATION":
      z += 2.8 * (f.relevance ?? 0) + 2.4 * (f.urgency ?? 0) - 3.1 * (f.fatigue ?? 0);
      break;
  }
  if (fixture.adversarial) z -= .05;
  return clamp(sigmoid(z));
}

abstract class OfflineEngine implements DecisionEngine {
  abstract readonly id: string;
  abstract readonly provider: string;
  abstract readonly model: string;
  readonly available = true;
  abstract probability(fixture: DecisionFixture): number;

  async decide(fixture: DecisionFixture): Promise<DecisionResult> {
    const start = performance.now();
    const probability = this.probability(fixture);
    const confidence = Math.abs(probability - .5) * 2;
    const abstained = confidence < .28;
    const label = probability >= .5 ? 1 : 0;
    const latencyMs = performance.now() - start;
    return {
      fixtureId: fixture.id,
      probability,
      label,
      confidence,
      abstained,
      latencyMs,
      estimatedCostUsd: 0,
      fallbackUsed: false,
    };
  }
}

export class RulesEngine extends OfflineEngine {
  readonly id = "rules-v1";
  readonly provider = "offline";
  readonly model = "deterministic-rules-v1";
  probability(fixture: DecisionFixture): number { return probabilityForRules(fixture); }
}

export class SignalClassifierEngine extends OfflineEngine {
  readonly id = "signal-classifier-v1";
  readonly provider = "offline";
  readonly model = "logistic-signal-v1";
  probability(fixture: DecisionFixture): number { return probabilityForSignalClassifier(fixture); }
}

export class UnavailableExternalEngine implements DecisionEngine {
  readonly available = false;
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  constructor(id: string, provider: string, model: string) {
    this.id = id;
    this.provider = provider;
    this.model = model;
  }
  async decide(fixture: DecisionFixture): Promise<DecisionResult> {
    const start = performance.now();
    return {
      fixtureId: fixture.id,
      probability: .5,
      label: 0,
      confidence: 0,
      abstained: true,
      latencyMs: performance.now() - start,
      estimatedCostUsd: 0,
      fallbackUsed: true,
    };
  }
}
