import assert from "node:assert/strict";
import { it } from "node:test";
import { handleChatRequest } from "../src/chat/http.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import { ChatReplies, devChatModel, type ChatModel } from "../src/chat/replies.ts";
import type { ChatClaim, ChatOutcome, ChatPort } from "../src/chat/port.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, OwnerApiPort } from "../src/http/types.ts";
import { MvpApiBoundary } from "../src/http/mvp-api.ts";
import { PostgresPersistenceError, type SqlExecutor } from "../src/persistence/postgres/types.ts";

const ownerId = "00000000-0000-0000-0000-0000000001a1";
const chatId = "00000000-0000-0000-0000-00000000c001";
const companion = "00000000-0000-0000-0000-0000000002a1";
const other = "00000000-0000-0000-0000-0000000002a2";
const messageId = "00000000-0000-0000-0000-00000000d001";

const settings = { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, revision: 1 } as const;
const turn = (overrides: Partial<ChatClaim> = {}): ChatClaim => ({
  chatId, replyId: messageId, claimId: "00000000-0000-0000-0000-00000000e001", replyTo: "OWNER", optional: false, direct: false,
  companion: { companionId: companion, displayName: "小光", identity: {}, settings },
  members: [{ companionId: companion, displayName: "小光" }, { companionId: other, displayName: "阿默" }],
  history: [{ companionId: null, body: "今天\n下雨了", action: null, mentions: [], sentAt: "2026-11-23T10:00:00Z" }],
  ...overrides,
});

/** A port that records calls; claim() hands out the queued turns. */
function fakePort(turns: ChatClaim[] = [], replying = false) {
  const calls: unknown[][] = []; const finished: [string, ChatOutcome, string[] | null][] = [];
  const port: ChatPort = {
    open: async (...args) => { calls.push(["open", ...args]); return { id: chatId, typing: [] }; },
    list: async () => { calls.push(["list"]); return { items: [] }; },
    read: async (...args) => { calls.push(["read", ...args]); return { chat: { typing: [], replying }, items: [], nextCursor: null }; },
    send: async (...args) => { calls.push(["send", ...args]); return { message: {}, typing: [], replying }; },
    act: async (...args) => { calls.push(["act", ...args]); return { chatId, message: {}, typing: [], replying }; },
    retry: async (...args) => { calls.push(["retry", ...args]); return { typing: [], replying }; },
    remove: async (...args) => { calls.push(["remove", ...args]); return { deleted: true }; },
    markRead: async (...args) => { calls.push(["markRead", ...args]); return {}; },
    badges: async () => { calls.push(["badges"]); return {}; },
    anniversary: async (...args) => { calls.push(["anniversary", ...args]); return {}; },
    saveAnniversary: async (...args) => { calls.push(["saveAnniversary", ...args]); return {}; },
    settings: async (...args) => { calls.push(["settings", ...args]); return {}; },
    memories: async (...args) => { calls.push(["memories", ...args]); return { items: [] }; },
    addMemory: async (...args) => { calls.push(["addMemory", ...args]); return {}; },
    deleteMemory: async (...args) => { calls.push(["deleteMemory", ...args]); return {}; },
    connectionView: async (...args) => { calls.push(["connectionView", ...args]); return { kind: "PLATFORM" }; },
    saveConnection: async (...args) => { calls.push(["saveConnection", ...args]); return { kind: args[1].kind }; },
    removeConnection: async (...args) => { calls.push(["removeConnection", ...args]); return { kind: "PLATFORM" }; },
    connection: async () => null,
    saveSettings: async (...args) => { calls.push(["saveSettings", ...args]); return {}; },
    claim: async () => turns.shift() ?? null,
    finish: async (replyId, _claim, outcome, bodies) => { finished.push([replyId, outcome, bodies]); return true; },
    reserve: async () => ({ decision: "RESERVED", transactionId: "tx" }),
    settle: async () => undefined,
    modelsEnabled: async models => models.map(() => true),
    diary: async () => ({}),
    deleteDiary: async () => ({}),
    diarySettings: async () => ({}),
    saveDiarySettings: async () => ({}),
    diaryBegin: async () => ({ status: "OFF" }),
    diaryReserve: async () => ({ decision: "STALE" }),
    diaryFinish: async () => null,
  };
  return { port, calls, finished };
}

const kicks: string[] = [];
const replies = { kick: (id: string) => { kicks.push(id); } } as unknown as ChatReplies;
const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): MvpHttpRequest => ({
  method, url: `/v0/${path}`,
  headers: { "Content-Type": "application/json", "Idempotency-Key": "stable-chat-test-key-1", ...headers },
  ...(body === undefined ? {} : { body }),
});
const session = (port?: ChatPort): AuthenticatedOwnerSession =>
  ({ ownerId, owner: {} as OwnerApiPort, ...(port === undefined ? {} : { chat: port }) });
const status = async (port: ChatPort, req: MvpHttpRequest) =>
  (await handleChatRequest(req, session(port), "trace", replies))?.status;
const refusal = async (port: ChatPort, req: MvpHttpRequest) =>
  handleChatRequest(req, session(port), "trace", replies).then(() => "ok", (error: PostgresPersistenceError) => error.code);

it("routes every chat request to the database as the signed-in Owner", async () => {
  const { port, calls } = fakePort();
  assert.equal(await status(port, request("chats")), 200);
  assert.equal(await status(port, request("chats", "POST", { companionIds: [companion, other], title: " 一家人 " })), 200);
  assert.equal(await status(port, request("chats", "POST", { companionIds: [companion], title: null })), 200);
  assert.equal(await status(port, request(`chats/${chatId}?cursor=${encodeURIComponent(`2026-11-23T10:00:00Z|${messageId}`)}`)), 200);
  assert.equal(await status(port, request(`chats/${chatId}`, "DELETE")), 200);
  assert.equal(await status(port, request(`chats/${chatId}/messages`, "POST", { body: " 你好 ", mentions: [other] })), 201);
  assert.equal(await status(port, request(`chats/${chatId}/messages/${messageId}/retry`, "POST")), 200);
  assert.equal(await status(port, request(`companions/${companion}/chat-settings`)), 200);
  assert.equal(await status(port, request(`companions/${companion}/chat-settings`, "PUT",
    { groupActivity: "QUIET", companionInteraction: "NONE", model: null, revision: 2 })), 200);
  const [open, direct, read, send] = [calls[1]!, calls[2]!, calls[3]!, calls[5]!];
  assert.equal(open[2], "一家人");
  assert.match(open[3] as string, /^[a-f0-9]{64}$/);
  assert.equal(direct[2], null);
  assert.deepEqual(read.slice(1), [chatId, "2026-11-23T10:00:00Z", messageId]);
  assert.deepEqual(send.slice(1, 4), [chatId, "你好", [other]]);
  assert.notEqual(send[4], "stable-chat-test-key-1", "the retry key is hashed with the Owner");
  assert.deepEqual(calls.at(-1), ["saveSettings", companion, { groupActivity: "QUIET", companionInteraction: "NONE", model: null, revision: 2 }]);
  assert.equal(await status(port, request(`companions/${companion}/actions`, "POST", { action: "PAT_HEAD" })), 201);
  const act = calls.at(-1)!;
  assert.deepEqual(act.slice(0, 3), ["act", companion, "PAT_HEAD"]);
  assert.equal(act[3], send[4], "the retry key is hashed the same way as for messages");
});

it("routes read state, badges and the anniversary", async () => {
  const { port, calls } = fakePort();
  assert.equal(await status(port, request(`chats/${chatId}/read`, "PUT", { messageId })), 200);
  assert.equal(await status(port, request("badges")), 200);
  assert.equal(await status(port, request(`companions/${companion}/anniversary`)), 200);
  assert.equal(await status(port, request(`companions/${companion}/anniversary`, "PUT",
    { startDate: "2024-02-29", timeZone: "Asia/Shanghai", revision: 1 })), 200);
  assert.equal(await status(port, request(`companions/${companion}/anniversary`, "PUT",
    { startDate: null, timeZone: "Europe/London", revision: 2 })), 200);
  assert.deepEqual(calls, [
    ["markRead", chatId, messageId], ["badges"], ["anniversary", companion],
    ["saveAnniversary", companion, "2024-02-29", "Asia/Shanghai", 1], ["saveAnniversary", companion, null, "Europe/London", 2],
  ]);
  calls.length = 0;
  for (const req of [
    request(`chats/${chatId}/read`, "PUT", { messageId: "nope" }),
    request(`chats/${chatId}/read`, "PUT", { messageId, extra: 1 }),
    request(`companions/${companion}/anniversary`, "PUT", { startDate: "2024-13-01", timeZone: "Asia/Shanghai", revision: 1 }),
    request(`companions/${companion}/anniversary`, "PUT", { startDate: "2024-01-01", timeZone: "", revision: 1 }),
    request(`companions/${companion}/anniversary`, "PUT", { startDate: "2024-01-01", timeZone: "Asia/Shanghai", revision: 0 }),
    request(`companions/${companion}/anniversary`, "PUT", { startDate: "2024-01-01", timeZone: "Asia/Shanghai" }),
  ]) assert.equal(await refusal(port, req), "INVALID_INPUT", JSON.stringify(req.body));
  for (const req of [request("badges", "POST"), request(`companions/${companion}/anniversary`, "DELETE"), request(`chats/${chatId}/read`)]) {
    assert.equal(await refusal(port, req), "NOT_FOUND");
  }
  assert.equal(calls.length, 0);
});

it("routes memories and refuses ones with credentials", async () => {
  const { port, calls } = fakePort();
  const memoryId = "00000000-0000-0000-0000-00000000f001";
  assert.equal(await status(port, request(`companions/${companion}/memories`)), 200);
  assert.equal(await status(port, request(`companions/${companion}/memories`, "POST", { body: " 主人喜欢下雨天 " })), 201);
  assert.equal(await status(port, request(`companions/${companion}/memories/${memoryId}`, "DELETE")), 200);
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [["memories", companion], ["addMemory", companion, "主人喜欢下雨天"], ["deleteMemory", companion, memoryId]]);
  assert.match(calls[1]![3] as string, /^[a-f0-9]{64}$/);
  calls.length = 0;
  for (const req of [
    request(`companions/${companion}/memories`, "POST", { body: "password: hunter2hunter2" }),
    request(`companions/${companion}/memories`, "POST", { body: "长".repeat(501) }),
    request(`companions/${companion}/memories`, "POST", { body: "ok", extra: 1 }),
    request(`companions/${companion}/memories/not-a-uuid`, "DELETE"),
  ]) assert.equal(await refusal(port, req), "INVALID_INPUT", JSON.stringify(req.body));
  for (const req of [request(`companions/${companion}/memories`, "PUT"), request(`companions/${companion}/memories/${memoryId}`)]) {
    assert.equal(await refusal(port, req), "NOT_FOUND");
  }
  assert.equal(calls.length, 0);
});

it("records home-room actions and starts the reply only when one may come", async () => {
  kicks.length = 0;
  await status(fakePort().port, request(`companions/${companion}/actions`, "POST", { action: "WAVE" }));
  assert.equal(kicks.length, 0);
  await status(fakePort([], true).port, request(`companions/${companion}/actions`, "POST", { action: "HUG" }));
  assert.deepEqual(kicks, [chatId]);
  const { port, calls } = fakePort();
  for (const req of [
    request(`companions/${companion}/actions`, "POST", { action: "KISS" }),
    request(`companions/${companion}/actions`, "POST", { action: "WAVE", extra: true }),
    request(`companions/${companion}/actions`, "POST", {}),
    request(`companions/${companion}/actions`, "POST", { action: "WAVE" }, { "Idempotency-Key": "short" }),
    request("companions/not-a-uuid/actions", "POST", { action: "WAVE" }),
  ]) assert.equal(await refusal(port, req), "INVALID_INPUT", JSON.stringify(req.body));
  assert.equal(await refusal(port, request(`companions/${companion}/actions`)), "NOT_FOUND");
  assert.equal(calls.length, 0);
});

it("starts writing replies only while replies are on the way", async () => {
  kicks.length = 0;
  await status(fakePort().port, request(`chats/${chatId}/messages`, "POST", { body: "无人回" }));
  assert.equal(kicks.length, 0);
  const busy = fakePort([], true).port;
  await status(busy, request(`chats/${chatId}/messages`, "POST", { body: "有人回" }));
  await status(busy, request(`chats/${chatId}`));
  await status(busy, request(`chats/${chatId}/messages/${messageId}/retry`, "POST"));
  assert.deepEqual(kicks, [chatId, chatId, chatId]);
});

it("refuses malformed requests before they reach the database", async () => {
  const { port, calls } = fakePort();
  const emoji = "\u{1F600}";
  assert.equal(await status(port, request(`chats/${chatId}/messages`, "POST", { body: emoji.repeat(2000) })), 201);
  const bad: MvpHttpRequest[] = [
    request("chats", "POST", { companionIds: [] }),
    request("chats", "POST", { companionIds: Array(9).fill(companion) }),
    request("chats", "POST", { companionIds: ["not-a-uuid"] }),
    request("chats", "POST", { companionIds: [companion], title: "x".repeat(41) }),
    request("chats", "POST", { companionIds: [companion], extra: 1 }),
    request("chats", "POST", { companionIds: [companion] }, { "Idempotency-Key": "short" }),
    request("chats", "POST", { companionIds: [companion] }, { "Content-Type": "text/plain" }),
    request(`chats/${chatId}/messages`, "POST", { body: "   " }),
    request(`chats/${chatId}/messages`, "POST", { body: emoji.repeat(2001) }),
    request(`chats/${chatId}/messages`, "POST", { body: 42 }),
    request(`chats/${chatId}/messages`, "POST", { body: "hi", mentions: "all" }),
    request(`chats/${chatId}/messages`, "POST", ["hi"]),
    request("chats/not-a-uuid"),
    request(`chats/${chatId}?cursor=yesterday|${messageId}`),
    request(`chats/${chatId}?cursor=2026-11-23T10:00:00Z`),
    request(`chats/${chatId}?cursor=2026-11-23T10:00:00Z|${messageId}|x`),
    request(`companions/${companion}/chat-settings`, "PUT", { groupActivity: "SOMETIMES", companionInteraction: "RARE", model: null, revision: 1 }),
    request(`companions/${companion}/chat-settings`, "PUT", { groupActivity: "ACTIVE", companionInteraction: 2, model: null, revision: 1 }),
    request(`companions/${companion}/chat-settings`, "PUT", { groupActivity: "ACTIVE", companionInteraction: "RARE", model: null, revision: 0 }),
    request(`companions/${companion}/chat-settings`, "PUT", { groupActivity: "ACTIVE", companionInteraction: "RARE", model: null }),
    request(`companions/${companion}/chat-settings`, "PUT", { groupActivity: "ACTIVE", companionInteraction: "RARE", model: "any-model", revision: 1 }),
  ];
  for (const req of bad) assert.equal(await refusal(port, req), "INVALID_INPUT", `${req.method} ${req.url} ${JSON.stringify(req.body)}`);
  for (const req of [request("chats", "PUT"), request(`chats/${chatId}/other`), request(`chats/${chatId}/messages/${messageId}/retry/x`, "POST"),
    request(`companions/${companion}/chat-settings`, "DELETE")]) {
    assert.equal(await refusal(port, req), "NOT_FOUND", `${req.method} ${req.url}`);
  }
  assert.equal(calls.length, 1);
  assert.equal(await handleChatRequest(request("community/feed"), session(port), "t", replies), undefined);
  assert.equal(await handleChatRequest(request(`companions/${companion}/profile`), session(port), "t", replies), undefined);
  assert.equal((await handleChatRequest(request("chats"), session(), "t", replies))?.status, 501);
});

it("is reachable through the API boundary after authentication", async () => {
  const { port } = fakePort();
  const api = new MvpApiBoundary({
    sessions: { resolve: async () => session(port) },
  });
  const ok = await api.handle(request("chats", "GET", undefined, { Authorization: "Bearer t" }));
  assert.equal(ok.status, 200);
  const missing = await api.handle(request(`chats/${chatId}/nope`, "GET", undefined, { Authorization: "Bearer t" }));
  assert.equal(missing.status, 404);
  assert.equal((await api.handle(request("chats"))).status, 401);
});

it("writes queued replies through the model and the safety scan", async () => {
  const model = (answer: Awaited<ReturnType<ChatModel["reply"]>> | Error): ChatModel =>
    ({ reply: async () => { if (answer instanceof Error) throw answer; return answer; } });
  const ownerSays = (body: string) => [{ companionId: null, body, action: null, mentions: [], sentAt: "2026-11-23T10:00:00Z" }];
  const cases: [ChatModel | undefined, ChatClaim, ChatOutcome, string[] | null][] = [
    [devChatModel, turn(), "SENT", ["（开发环境假回复）我是小光", "收到：「今天 下雨了」"]],
    [devChatModel, turn({ optional: true }), "PASSED", null],
    [devChatModel, turn({ optional: true, history: ownerSays("小光在吗") }), "SENT", ["（开发环境假回复）我是小光", "收到：「小光在吗」"]],
    [devChatModel, turn({ optional: true, history: ownerSays("大家早") }), "SENT", ["（开发环境假回复）我是小光", "收到：「大家早」"]],
    [devChatModel, turn({ replyTo: "COMPANION", optional: true, companion: { companionId: other, displayName: "阿默", identity: {}, settings },
      history: [{ companionId: companion, body: "嗯", action: null, mentions: [], sentAt: "2026-11-23T10:00:01Z" }] }),
      "SENT", ["（开发环境假回复）阿默接着小光的话说一句。"]],
    [devChatModel, turn({ replyTo: "COMPANION", history: [] }), "SENT", ["（开发环境假回复）小光接着大家的话说一句。"]],
    [devChatModel, turn({ history: [] }), "SENT", ["（开发环境假回复）我是小光", "收到：「」"]],
    [devChatModel, turn({ direct: true, optional: true, history: [{ companionId: null, body: null, action: "HUG", mentions: [], sentAt: "t" }] }),
      "SENT", ["（开发环境假回复）小光知道你在小家里抱了抱你"]],
    [devChatModel, turn({ direct: true, optional: true, history: [] }), "SENT", ["（开发环境假回复）小光知道你来过"]],
    [model(new Error("down")), turn({ direct: true, optional: true }), "PASSED", null],
    [model(new Error("down")), turn({ optional: true }), "ERROR", null],
    [model({ messages: ["  好的 ", "", "联系我 13800138000 吧"] }), turn(), "SENT", ["好的", "联系我 [REDACTED_PII] 吧"]],
    [model({ messages: ["一", "二", "三", "四"] }), turn(), "SENT", ["一", "二", "三\n四"]],
    [model({ messages: ["没事", "password: hunter2"] }), turn(), "BLOCKED", null],
    [model({ messages: ["   "] }), turn(), "ERROR", null],
    [model({ messages: ["长".repeat(2001)] }), turn(), "ERROR", null],
    [model(new Error("down")), turn(), "ERROR", null],
    [model({ pass: true }), turn({ optional: true }), "PASSED", null],
    [model({ pass: true }), turn(), "ERROR", null],
    [undefined, turn(), "UNAVAILABLE", null],
    [undefined, turn({ optional: true }), "PASSED", null],
    [model({ text: "wrong shape" } as never), turn(), "ERROR", null],
    [model({ refused: true }), turn(), "BLOCKED", null],
    [model({ failed: "QUOTA" }), turn(), "QUOTA", null],
    [model({ failed: "DISABLED" }), turn(), "DISABLED", null],
    [model({ failed: "QUOTA" }), turn({ optional: true }), "PASSED", null],
    [model({ messages: ["a@b.co ".repeat(285)] }), turn(), "ERROR", null],
  ];
  for (const [chosen, claim, outcome, bodies] of cases) {
    const { port, finished } = fakePort([claim]);
    assert.equal(await new ChatReplies(chosen).drain(chatId, port), 1);
    assert.deepEqual(finished, [[messageId, outcome, bodies]], JSON.stringify(claim.history));
  }
  const hung = fakePort([turn()]);
  let aborted = false;
  await new ChatReplies({ reply: (_turn, { signal }) => new Promise(() => signal.addEventListener("abort", () => { aborted = true; })) }, 5)
    .drain(chatId, hung.port);
  assert.deepEqual(hung.finished, [[messageId, "ERROR", null]], "a model that never answers fails the turn instead of holding the chat");
  assert.ok(aborted, "the hung model call is told to stop");
  const long = "很长".repeat(30);
  const { port, finished } = fakePort([turn({ history: ownerSays(long) })]);
  await new ChatReplies(devChatModel).drain(chatId, port);
  assert.match(finished[0]![2]![1]!, /「很长很长.*……」$/);
});

it("runs one background writer per chat and never throws from kick", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let claims = 0;
  const { port, finished } = fakePort();
  port.claim = async () => { claims += 1; if (claims === 1) { await gate; return turn(); } return null; };
  const writer = new ChatReplies(devChatModel);
  writer.kick(chatId, port);
  writer.kick(chatId, port);
  assert.equal(claims, 1);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished.length, 1);
  port.claim = async () => { throw new Error("database down"); };
  writer.kick(chatId, port);
  await new Promise(resolve => setTimeout(resolve, 10));
  writer.kick(chatId, port); // the failed run let go of the chat
});

it("maps database payloads and errors in the Postgres adapter", async () => {
  const seen: [string, readonly unknown[]][] = [];
  let rows: Record<string, unknown>[] = [{ payload: { ok: true } }];
  const executor: SqlExecutor = { query: async (sql, values) => { seen.push([sql, values]); return { rows } as never; } };
  const adapter = new PostgresChatAdapter(executor);
  await adapter.open([companion], null, "k");
  await adapter.list();
  await adapter.read(chatId, null, null);
  await adapter.send(chatId, "hi", [], "k");
  await adapter.retry(chatId, messageId);
  await adapter.remove(chatId);
  await adapter.settings(companion);
  await adapter.saveSettings(companion, { groupActivity: "ACTIVE", companionInteraction: "LIVELY", model: "m", revision: 1 });
  assert.deepEqual(seen.at(-1)![1], [companion, "ACTIVE", "LIVELY", "m", 1]);
  rows = [{ payload: { decision: "QUOTA" } }];
  assert.deepEqual(await adapter.reserve({ replyId: messageId, claimId: "c", purpose: "REPLY", provider: "p", model: "m",
    pricingVersion: "v", inputTokens: 1, outputTokens: 2, costMinor: 3, traceId: "t" }), { decision: "QUOTA" });
  assert.deepEqual(seen.at(-1)![1], [messageId, "c", "REPLY", "p", "m", "v", 1, 2, 3, "t"]);
  rows = [{ payload: { settled: true } }];
  await adapter.settle("tx", 1, 2, 3, true);
  assert.deepEqual(seen.at(-1)![1], ["tx", 1, 2, 3, true]);
  rows = [{ payload: [true, false] }];
  assert.deepEqual(await adapter.modelsEnabled([{ provider: "a", model: "x" }, { provider: "b", model: "y" }]), [true, false]);
  assert.deepEqual(seen.at(-1)![1], [["a", "b"], ["x", "y"]]);
  rows = [{ payload: [1] }];
  await assert.rejects(adapter.modelsEnabled([]), { code: "DATABASE_ERROR" });
  rows = [{ payload: { ok: true } }];
  assert.deepEqual(await adapter.claim(chatId), { ok: true });
  rows = [{ payload: { accepted: true } }];
  assert.equal(await adapter.finish(messageId, "c", "SENT", ["hi"]), true);
  rows = [{ payload: null }];
  assert.equal(await adapter.claim(chatId), null);
  await assert.rejects(adapter.list(), { code: "DATABASE_ERROR" });
  rows = [];
  await assert.rejects(adapter.list(), { code: "DATABASE_ERROR" });
  rows = [{ payload: [1] }];
  await assert.rejects(adapter.list(), { code: "DATABASE_ERROR" });
  const failing = new PostgresChatAdapter({ query: async () => { throw Object.assign(new Error("x"), { code: "P0001" }); } });
  await assert.rejects(failing.read(chatId, null, null), { code: "NOT_FOUND" });
});
