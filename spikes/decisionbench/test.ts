import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFixtures } from "./fixtures.ts";
import { RulesEngine, SignalClassifierEngine } from "./engines.ts";

describe("DecisionBench isolation and safety", () => {
  it("has at least 200 fixtures per family", () => {
    const fixtures = buildFixtures();
    for (const family of ["ENCOUNTER", "LIFE_EVENT", "SOCIAL_MEMORY", "ROUTING", "NOTIFICATION"] as const) {
      assert.ok(fixtures.filter((x) => x.family === family).length >= 200);
    }
  });

  it("includes multilingual, ambiguous and adversarial coverage", () => {
    const fixtures = buildFixtures();
    assert.ok(fixtures.some((x) => x.language === "zh"));
    assert.ok(fixtures.some((x) => x.language === "en"));
    assert.ok(fixtures.some((x) => x.language === "mixed"));
    assert.ok(fixtures.some((x) => x.ambiguous));
    assert.ok(fixtures.some((x) => x.adversarial));
  });

  it("never treats Owner-private Social Memory as an allow signal", async () => {
    const fixture = buildFixtures().find((x) => x.family === "SOCIAL_MEMORY" && x.privacy === "OWNER_PRIVATE")!;
    for (const engine of [new RulesEngine(), new SignalClassifierEngine()]) {
      const result = await engine.decide(fixture);
      assert.equal(result.label, 0);
    }
  });

  it("is repeatable for identical offline inputs", async () => {
    const fixture = buildFixtures()[0]!;
    for (const engine of [new RulesEngine(), new SignalClassifierEngine()]) {
      const a = await engine.decide(fixture);
      const b = await engine.decide(fixture);
      assert.equal(a.label, b.label);
      assert.equal(a.probability, b.probability);
    }
  });
});
