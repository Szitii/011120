import assert from "node:assert/strict";
import test from "node:test";
import { createChatClient } from "../src/chat/client.ts";
import type { CompanionActionResult } from "../../contracts/chat.ts";

test("room actions use the companion route and preserve the caller's idempotency key", async () => {
  const requests: unknown[] = [];
  const response: CompanionActionResult = {
    chatId: "direct-chat",
    message: {
      id: "action-message",
      companionId: null,
      body: null,
      action: "CUDDLE",
      mentions: [],
      status: "SENT",
      failure: null,
      retryable: false,
      sentAt: "2026-11-23T00:00:00Z",
    },
    typing: [],
    replying: true,
  };
  const client = createChatClient(async <T>(...request: unknown[]) => {
    requests.push(request);
    return response as T;
  });

  const send = () => client.sendAction("current/companion", "CUDDLE", "same-key-on-retry");
  assert.deepEqual(await send(), response);
  assert.deepEqual(await send(), response);
  const expected = ["POST", "/v0/companions/current%2Fcompanion/actions", { action: "CUDDLE" }, "same-key-on-retry"];
  assert.deepEqual(requests, [expected, expected]);
});
