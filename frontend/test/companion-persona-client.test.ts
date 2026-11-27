import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatClient } from "../src/chat/client.ts";

test("handoff routes carry owned knowledge settings", async () => {
  const calls: unknown[][] = [];
  const client = createChatClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return {} as T;
  });
  const entry = { keys: ["猫"], body: "一只猫", enabled: false };
  const skill = { title: "英语", body: "练习英语", enabled: true };
  await client.saveWorldEntry!("a/b", entry);
  await client.saveWorldEntry!("a/b", entry, "entry");
  await client.toggleOfficialSkill!("a/b", "s/1", false);
  await client.saveOwnSkill!("a/b", skill, "own");
  assert.deepEqual(calls, [
    ["POST", "/v0/companions/a%2Fb/world-entries", entry],
    ["PUT", "/v0/companions/a%2Fb/world-entries/entry", entry],
    ["PUT", "/v0/companions/a%2Fb/skills/s%2F1", { enabled: false }],
    ["PUT", "/v0/companions/a%2Fb/own-skills/own", skill],
  ]);
});
