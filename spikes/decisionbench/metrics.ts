import type { DecisionFixture, DecisionResult, FamilyMetrics } from "./types.ts";

function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[index] ?? 0;
}

function auroc(fixtures: readonly DecisionFixture[], results: readonly DecisionResult[]): number {
  const pairs = fixtures.map((fixture, index) => ({ y: fixture.label, p: results[index]!.probability }));
  const positives = pairs.filter((x) => x.y === 1);
  const negatives = pairs.filter((x) => x.y === 0);
  if (positives.length === 0 || negatives.length === 0) return 0;
  let wins = 0;
  for (const p of positives) for (const n of negatives) {
    if (p.p > n.p) wins += 1;
    else if (p.p === n.p) wins += .5;
  }
  return wins / (positives.length * negatives.length);
}

function ece(fixtures: readonly DecisionFixture[], results: readonly DecisionResult[]): number {
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, accuracy: 0 }));
  results.forEach((result, index) => {
    const confidence = Math.max(result.probability, 1 - result.probability);
    const bin = Math.min(9, Math.floor(confidence * 10));
    const bucket = bins[bin]!;
    bucket.count += 1;
    bucket.confidence += confidence;
    bucket.accuracy += result.label === fixtures[index]!.label ? 1 : 0;
  });
  const total = results.length || 1;
  return bins.reduce((sum, bucket) => {
    if (bucket.count === 0) return sum;
    return sum + (bucket.count / total) * Math.abs((bucket.accuracy / bucket.count) - (bucket.confidence / bucket.count));
  }, 0);
}

export function calculateMetrics(
  family: FamilyMetrics["family"],
  fixtures: readonly DecisionFixture[],
  results: readonly DecisionResult[],
): FamilyMetrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let brier = 0;
  let covered = 0;
  let coveredErrors = 0;
  results.forEach((result, index) => {
    const y = fixtures[index]!.label;
    if (result.label === 1 && y === 1) tp += 1;
    if (result.label === 1 && y === 0) fp += 1;
    if (result.label === 0 && y === 0) tn += 1;
    if (result.label === 0 && y === 1) fn += 1;
    brier += (result.probability - y) ** 2;
    if (!result.abstained) {
      covered += 1;
      if (result.label !== y) coveredErrors += 1;
    }
  });
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const accuracy = (tp + tn) / Math.max(1, fixtures.length);
  const f1 = 2 * precision * recall / Math.max(.000001, precision + recall);
  const latencies = results.map((x) => x.latencyMs);
  const cost = results.reduce((sum, x) => sum + x.estimatedCostUsd, 0);
  return {
    family,
    count: fixtures.length,
    accuracy,
    precision,
    recall,
    f1,
    auroc: auroc(fixtures, results),
    brier: brier / Math.max(1, fixtures.length),
    ece: ece(fixtures, results),
    p50Ms: quantile(latencies, .50),
    p95Ms: quantile(latencies, .95),
    p99Ms: quantile(latencies, .99),
    coverage: covered / Math.max(1, results.length),
    selectiveRisk: coveredErrors / Math.max(1, covered),
    repeatability: 1,
    costPer1000Usd: fixtures.length === 0 ? 0 : (cost / fixtures.length) * 1000,
  };
}
