import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatClient } from "../src/chat/client.ts";

test("proactive chat settings honor the explicit server capability", async () => {
  const client = createChatClient(async <T>(method: string, path: string) => {
    assert.deepEqual([method, path], ["GET", "/v0/features"]);
    return { companionReach: true } as T;
  });
  assert.equal((await client.features!()).companionReach, true);
});
