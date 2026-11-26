import { test } from "node:test";
import assert from "node:assert/strict";
import { chatReadTarget, createChatClient } from "../src/chat/client.ts";
import { formatChatAction } from "../src/chat/actions.ts";
import { createCommunityClient } from "../src/community/client.ts";

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

test("model connection setup and removal use the same companion resource", async () => {
  const calls: unknown[][] = [];
  const client = createChatClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return {} as T;
  });
  const body = { kind: "EXTERNAL", name: "家机", endpoint: "https://example.com/chat", bearerToken: "", consent: true } as const;
  await client.getConnection!("companion");
  await client.saveConnection!("companion", body);
  await client.removeConnection!("companion");
  assert.deepEqual(calls, [
    ["GET", "/v0/companions/companion/connection"],
    ["PUT", "/v0/companions/companion/connection", body],
    ["DELETE", "/v0/companions/companion/connection"],
  ]);
});

test("platform feature flags require an explicit true value and use the authenticated feature endpoint", async () => {
  const client = createChatClient(async <T>(method: string, path: string) => {
    assert.deepEqual([method, path], ["GET", "/v0/features"]);
    return { groupChatCreate: true, groupChatSend: "true" } as T;
  });
  assert.deepEqual(await client.features!(), { groupChatCreate: true, groupChatSend: false, connections: false });
});

test("owner voice sends the recording to the chat with the caller's retry key", async () => {
  const calls: unknown[][] = [];
  const client = createChatClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return {} as T;
  });
  const clip = { audio: "AQID", mime: "audio/mp4", durationMs: 700 } as const;
  await client.sendVoice!("chat/id", clip, "chat-voice-fixture");
  assert.deepEqual(calls, [["POST", "/v0/chats/chat%2Fid/voice", clip, "chat-voice-fixture"]]);
});

test("agent heartbeat keys use companion-scoped management routes with server-default expiry", async () => {
  const calls: unknown[][] = [];
  const client = createChatClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return {} as T;
  });
  await client.listAgentKeys!("companion/a");
  await client.createAgentKey!("companion/a", "我的 Agent");
  await client.createAgentKey!("companion/a", "投稿 Agent", ["COMMUNITY_READ", "COMMUNITY_DRAFT"]);
  await client.revokeAgentKey!("companion/a", "key/b");
  assert.deepEqual(calls, [
    ["GET", "/v0/companions/companion%2Fa/agent-keys"],
    ["POST", "/v0/companions/companion%2Fa/agent-keys", { name: "我的 Agent" }],
    ["POST", "/v0/companions/companion%2Fa/agent-keys", { name: "投稿 Agent", scopes: ["COMMUNITY_READ", "COMMUNITY_DRAFT"] }],
    ["DELETE", "/v0/companions/companion%2Fa/agent-keys/key%2Fb"],
  ]);
});

test("avatar updates use the owner or owned companion endpoint and accept explicit reset", async () => {
  const calls: unknown[][] = [];
  const client = createChatClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return args[2] as T;
  });
  assert.deepEqual(await client.saveAvatar!(null, "preset:pixel_long_hair"), { avatar: "preset:pixel_long_hair" });
  assert.deepEqual(await client.saveAvatar!("companion/a", null), { avatar: null });
  assert.deepEqual(calls, [
    ["PUT", "/v0/owner/avatar", { avatar: "preset:pixel_long_hair" }],
    ["PUT", "/v0/companions/companion%2Fa/avatar", { avatar: null }],
  ]);
});

test("chat read position advances to the newest visible message, including failed and blocked replies", () => {
  const failedReply = { id: "failed", status: "FAILED" } as const;
  const blockedReply = { id: "blocked", status: "BLOCKED" } as const;
  assert.equal(chatReadTarget({ unreadCount: 1, readUpTo: "earlier" }, failedReply), "failed");
  assert.equal(chatReadTarget({ unreadCount: 2, readUpTo: "earlier" }, blockedReply), "blocked");
  assert.equal(chatReadTarget({ unreadCount: 1, readUpTo: "blocked" }, blockedReply), undefined);
  assert.equal(chatReadTarget({ unreadCount: 0 }, blockedReply), undefined);
});

test("chat action labels distinguish owner and companion initiators", () => {
  assert.equal(formatChatAction("HUG", null), "你抱了抱 TA");
  assert.equal(formatChatAction("HUG", "companion-1"), "TA 抱了抱你");
  assert.equal(formatChatAction("PAT_HEAD", null), "你摸了摸 TA 的头");
  assert.equal(formatChatAction("PAT_HEAD", "companion-1"), "TA 摸了摸你的头");
});

test("persona read/write and connection copy use the companion routes", async () => {
  const calls: unknown[][] = [];
  const client = createChatClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return {} as T;
  });
  await client.getPersona!("companion/a");
  await client.savePersona!("companion/a", { version: 3, speakingStyle: "短句" });
  await client.saveConnection!("companion/b", { copyFrom: "companion/a", consent: true });
  assert.deepEqual(calls, [
    ["GET", "/v0/companions/companion%2Fa/persona"],
    ["PUT", "/v0/companions/companion%2Fa/persona", { version: 3, speakingStyle: "短句" }],
    ["PUT", "/v0/companions/companion%2Fb/connection", { copyFrom: "companion/a", consent: true }],
  ]);
});

test("community publish forwards media attachments alongside visibility and mentions", async () => {
  const calls: unknown[][] = [];
  const community = createCommunityClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return {} as T;
  });
  const media = [{ path: "actor-1/00000000-0000-4000-8000-000000000001.jpg", width: 800, height: 600 }];
  await community.publish({ kind: "OWNER", id: "owner-1" }, "晚霞", "post-key", {
    visibility: "FOLLOWERS",
    mentions: ["actor-2"],
    media,
  });
  assert.deepEqual(calls, [
    [
      "POST",
      "/v0/community/posts?actorKind=OWNER&actorId=owner-1",
      { body: "晚霞", visibility: "FOLLOWERS", mentions: ["actor-2"], media },
      "post-key",
    ],
  ]);
});
