import assert from "node:assert/strict";
import test from "node:test";
import { importCardName, normalizeImportCard } from "../src/onboarding/import-card.ts";

test("structured import picks the documented name priority and withholds private records", () => {
  const input = {
    data: { name: "首选" }, name: "第二", identity: { display_name: "第三", public_interests: ["听歌"] },
    displayName: "第四", character: { name: "第五" }, raw_persona_text: "温和",
    private_memory_vault_v2: { secret: "never uploaded" },
  };
  assert.deepEqual(normalizeImportCard(input), { name: "首选", description: "温和\n公开兴趣：听歌", personality: "" });
  assert.deepEqual(normalizeImportCard({ identity: input.identity, raw_persona_text: "温和" }),
    { name: "第三", description: "温和\n公开兴趣：听歌", personality: "" });
  assert.equal(normalizeImportCard({ character: { name: "第五" } })?.name, "第五");
});

test("preserves standard V2 layout for firewall review and accepts a manually supplied missing name", () => {
  const card = normalizeImportCard({
    spec: "chara_card_v2", spec_version: "2.0",
    data: { name: " ", description: "简介", personality: "性格", system_prompt: "待防火墙检查" },
  }, "  家机  ")!;
  assert.equal(importCardName(card), "家机");
  assert.deepEqual(card.data, { name: "家机", description: "简介", personality: "性格", system_prompt: "待防火墙检查" });
  assert.equal(normalizeImportCard(["不是角色卡"]), undefined);
});

test("custom exports pass the supported memory list to the firewall while retaining the private vault locally", () => {
  const card = normalizeImportCard({
    identity: { display_name: "阿宁" }, memories: ["一起去看海", { private: true }],
    private_memory_vault: ["不随请求发送"],
  });
  assert.deepEqual(card, { name: "阿宁", description: "", personality: "", memories: ["一起去看海"] });
});
