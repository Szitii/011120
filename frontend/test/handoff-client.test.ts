import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatClient } from "../src/chat/client.ts";

test("handoff requests use the owned chat and companion paths with the correct write payload", async () => {
  const calls: unknown[][] = [];
  const client = createChatClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return {} as T;
  });
  await client.badges!();
  await client.markRead!("chat", "latest");
  await client.saveAnniversary!("companion", { startDate: null, timeZone: "Asia/Shanghai", revision: 4 });
  await client.addMemory!("companion", "一起去看海", "memory-key");
  await client.deleteMemory!("companion", "memory");
  assert.deepEqual(calls, [
    ["GET", "/v0/badges"],
    ["PUT", "/v0/chats/chat/read", { messageId: "latest" }],
    ["PUT", "/v0/companions/companion/anniversary", { startDate: null, timeZone: "Asia/Shanghai", revision: 4 }],
    ["POST", "/v0/companions/companion/memories", { body: "一起去看海" }, "memory-key"],
    ["DELETE", "/v0/companions/companion/memories/memory"],
  ]);
});
