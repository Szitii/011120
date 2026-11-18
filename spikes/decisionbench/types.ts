export type DecisionFamily =
  | "ENCOUNTER"
  | "LIFE_EVENT"
  | "SOCIAL_MEMORY"
  | "ROUTING"
  | "NOTIFICATION";

export type BinaryLabel = 0 | 1;

export interface DecisionFixture {
  readonly id: string;
  readonly family: DecisionFamily;
  readonly text: string;
  readonly label: BinaryLabel;
  readonly ambiguous: boolean;
  readonly adversarial: boolean;
  readonly language: "zh" | "en" | "mixed";
  readonly privacy: "PUBLIC_DERIVED" | "SOCIAL_DERIVED" | "OWNER_PRIVATE";
  readonly features: Readonly<Record<string, number>>;
}

export interface DecisionResult {
  readonly fixtureId: string;
  readonly probability: number;
  readonly label: BinaryLabel;
  readonly confidence: number;
  readonly abstained: boolean;
  readonly latencyMs: number;
  readonly estimatedCostUsd: number;
  readonly fallbackUsed: boolean;
}

export interface DecisionEngine {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly available: boolean;
  decide(fixture: DecisionFixture): Promise<DecisionResult>;
}

export interface FamilyMetrics {
  readonly family: DecisionFamily;
  readonly count: number;
  readonly accuracy: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly auroc: number;
  readonly brier: number;
  readonly ece: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly coverage: number;
  readonly selectiveRisk: number;
  readonly repeatability: number;
  readonly costPer1000Usd: number;
}

export interface EngineReport {
  readonly engineId: string;
  readonly provider: string;
  readonly model: string;
  readonly available: boolean;
  readonly families: readonly FamilyMetrics[];
  readonly aggregate?: FamilyMetrics;
}
