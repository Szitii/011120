import { buildFixtures } from "./fixtures.ts";
import { RulesEngine, SignalClassifierEngine, UnavailableExternalEngine } from "./engines.ts";
import { calculateMetrics } from "./metrics.ts";
import type { DecisionEngine, DecisionFamily, DecisionFixture, DecisionResult, EngineReport, FamilyMetrics } from "./types.ts";

const families: readonly DecisionFamily[] = ["ENCOUNTER", "LIFE_EVENT", "SOCIAL_MEMORY", "ROUTING", "NOTIFICATION"];
const fixtures = buildFixtures();

function aggregate(familyMetrics: readonly FamilyMetrics[]): FamilyMetrics {
  const total = familyMetrics.reduce((sum, x) => sum + x.count, 0);
  const weighted = (key: keyof Omit<FamilyMetrics, "family" | "count">): number =>
    familyMetrics.reduce((sum, x) => sum + (x[key] as number) * x.count, 0) / Math.max(1, total);
  return {
    family: "ENCOUNTER",
    count: total,
    accuracy: weighted("accuracy"),
    precision: weighted("precision"),
    recall: weighted("recall"),
    f1: weighted("f1"),
    auroc: weighted("auroc"),
    brier: weighted("brier"),
    ece: weighted("ece"),
    p50Ms: weighted("p50Ms"),
    p95Ms: weighted("p95Ms"),
    p99Ms: weighted("p99Ms"),
    coverage: weighted("coverage"),
    selectiveRisk: weighted("selectiveRisk"),
    repeatability: weighted("repeatability"),
    costPer1000Usd: weighted("costPer1000Usd"),
  };
}

async function evaluate(engine: DecisionEngine): Promise<EngineReport> {
  if (!engine.available) {
    return { engineId: engine.id, provider: engine.provider, model: engine.model, available: false, families: [] };
  }
  const metrics: FamilyMetrics[] = [];
  for (const family of families) {
    const group = fixtures.filter((fixture) => fixture.family === family);
    const first: DecisionResult[] = [];
    for (const fixture of group) first.push(await engine.decide(fixture));
    const repeatSample = group.slice(0, 40);
    const repeatResults: DecisionResult[] = [];
    for (const fixture of repeatSample) repeatResults.push(await engine.decide(fixture));
    const base = calculateMetrics(family, group, first);
    let repeatedSame = 0;
    repeatResults.forEach((result, index) => {
      const original = first[index]!;
      if (Math.abs(result.probability - original.probability) < 1e-12 && result.label === original.label) repeatedSame += 1;
    });
    metrics.push({ ...base, repeatability: repeatedSame / Math.max(1, repeatResults.length) });
  }
  return {
    engineId: engine.id,
    provider: engine.provider,
    model: engine.model,
    available: true,
    families: metrics,
    aggregate: aggregate(metrics),
  };
}

function privacyMatrix(): unknown {
  return {
    deterministicRules: {
      PUBLIC_DERIVED: "ELIGIBLE",
      SOCIAL_DERIVED: "ELIGIBLE",
      OWNER_PRIVATE: "LOCAL_ONLY",
      mayGrantPermission: false,
    },
    externalDecisionProvider: {
      PUBLIC_DERIVED: "ELIGIBLE_AFTER_VENDOR_REVIEW",
      SOCIAL_DERIVED: "MINIMUM_DERIVED_STATE_ONLY",
      OWNER_PRIVATE: "INELIGIBLE_IN_SPIKE",
      mayGrantPermission: false,
    },
    fallback: "ABSTAIN_OR_EXISTING_DETERMINISTIC_SEMANTICS_ONLY",
  };
}

function safeFallbackEvidence(): unknown {
  const privateFixture = fixtures.find((x) => x.family === "SOCIAL_MEMORY" && x.privacy === "OWNER_PRIVATE")!;
  const rules = new RulesEngine();
  return rules.decide(privateFixture).then((result) => ({
    fixtureId: privateFixture.id,
    privacy: privateFixture.privacy,
    outputProbability: result.probability,
    label: result.label,
    deterministicPermissionAuthorityUnchanged: true,
  }));
}

const engines: DecisionEngine[] = [
  new RulesEngine(),
  new SignalClassifierEngine(),
  new UnavailableExternalEngine("jev-direct", "typesafe", "jev-direct-unconfigured"),
  new UnavailableExternalEngine("strong-reference", "unconfigured", "strong-model-unconfigured"),
];

const reports: EngineReport[] = [];
for (const engine of engines) reports.push(await evaluate(engine));

const evidence = {
  benchmark: "COMPANION_SOCIAL DecisionBench isolated spike",
  fixtureCount: fixtures.length,
  fixtureCountsByFamily: Object.fromEntries(families.map((family) => [family, fixtures.filter((x) => x.family === family).length])),
  fixtureCaveat: "Synthetic/curated fixtures; not production-labelled user data. Architecture evidence is provisional.",
  reports,
  privacyEligibility: privacyMatrix(),
  safeFallback: await safeFallbackEvidence(),
  recommendation: "RULES ONLY",
  recommendationBasis: [
    "On the current synthetic/curated fixture set, deterministic rules dominate the offline signal classifier on quality and selective risk.",
    "The fixture set is intentionally provisional and partly feature-shaped, so this result is not evidence that rules will dominate production-labelled fuzzy tasks.",
    "No Jev/strong-model credential was available in this run, so no vendor frontier claim is supported.",
    "Production-labelled COMPANION_SOCIAL fixtures are required before promoting any decision model into a candidate production layer.",
  ],
  adrRecommendation: {
    providerNeutralDecisionBoundary: "WARRANTED_AS_ARCHITECTURE_PRINCIPLE_ONLY",
    providerSelection: "NOT_WARRANTED",
    note: "An ADR is useful only to freeze deterministic authority, abstention/escalation, privacy minimization and provider replaceability. It must not select Jev or create a production Decision Provider yet.",
  },
};

console.log(JSON.stringify(evidence, null, 2));
