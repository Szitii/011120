import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKINS, mergeRemoteSkin } from "../src/theme/skinTokens.ts";

test("all light built-in skins preserve pure crisp white canvas and dark charcoal ink", () => {
  for (const key of ["default", "glacier", "pearl"] as const) {
    const skin = BUILTIN_SKINS[key];
    assert.equal(skin.isDark, false);
    assert.equal(skin.colors.canvas, "#FFFFFF");
    assert.equal(skin.colors.ink, "#18181B");
    assert.ok(skin.chatBubbles.humanFill.length > 0);
    assert.ok(skin.chatBubbles.aiFill.length > 0);
    assert.ok(skin.roomPack.packId.startsWith("flat-2d-"));
  }
});

test("mergeRemoteSkin safely merges partial paid skin overrides without dropping required slots", () => {
  const custom = mergeRemoteSkin(BUILTIN_SKINS.default, {
    id: "paid-bubble-mint",
    name: "薄荷气泡单品",
    tier: "paid",
    chatBubbles: {
      humanFill: "rgba(16, 185, 129, 0.78)",
      humanText: "#FFFFFF",
      humanBorder: "rgba(255, 255, 255, 0.55)",
      aiFill: BUILTIN_SKINS.default.chatBubbles.aiFill,
      aiText: BUILTIN_SKINS.default.chatBubbles.aiText,
      aiBorder: BUILTIN_SKINS.default.chatBubbles.aiBorder,
    },
  });

  assert.equal(custom.id, "paid-bubble-mint");
  assert.equal(custom.colors.canvas, "#FFFFFF");
  assert.equal(custom.chatBubbles.humanFill, "rgba(16, 185, 129, 0.78)");
  assert.equal(custom.actorAnchor.companionBarBg, "#18181B");
});
