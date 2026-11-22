import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKINS } from "../src/theme/skinTokens.ts";

test("all light built-in skins preserve pure crisp white canvas and dark charcoal ink", () => {
  for (const key of ["default", "glacier", "pearl"] as const) {
    const skin = BUILTIN_SKINS[key];
    assert.equal(skin.isDark, false);
    assert.equal(skin.colors.canvas, "#FFFFFF");
    assert.equal(skin.colors.ink, "#18181B");
    assert.ok(skin.chatBubbles.humanFill.length > 0);
    assert.ok(skin.chatBubbles.aiFill.length > 0);
  }
});

test("the skin picker keeps all four presets selectable by their own IDs", () => {
  assert.deepEqual(
    Object.entries(BUILTIN_SKINS).map(([key, skin]) => [key, skin.id]),
    [["default", "default"], ["glacier", "glacier"], ["pearl", "pearl"], ["titanium", "titanium"]],
  );
  assert.equal(BUILTIN_SKINS.titanium.isDark, true);
  assert.equal(BUILTIN_SKINS.titanium.colors.tabInactive, "#94A3B8");
});
