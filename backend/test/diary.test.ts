import assert from "node:assert/strict";
import { it } from "node:test";
import { handleChatRequest } from "../src/chat/http.ts";
import { ChatCatalog, type CatalogFile } from "../src/chat/models.ts";
import { PlatformChatModel } from "../src/chat/platform.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import { diaryPrompt } from "../src/chat/prompt.ts";
import type { CallModel } from "../src/chat/providers.ts";
import { ChatReplies, devChatModel, type ChatModel, type DiaryAnswer } from "../src/chat/replies.ts";
import type { Booking, ChatPort, DiaryJob, DiaryStart, ReservationDecision } from "../src/chat/port.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, OwnerApiPort } from "../src/http/types.ts";
import type { PostgresPersistenceError, SqlExecutor } from "../src/persistence/postgres/types.ts";
import type { DiaryEntry, DiaryWriteResult } from "../../contracts/chat.ts";

const ownerId = "00000000-0000-0000-0000-0000000001a1";
const companion = "00000000-0000-0000-0000-0000000002a1";
const entryId = "00000000-0000-0000-0000-00000000f001";
const entry: DiaryEntry = { id: entryId, companionId: companion, body: "今天很好。", writtenAt: "2026-11-23T12:00:00Z" };

const job = (overrides: Partial<DiaryJob> = {}): DiaryJob => ({
  status: "WRITE", entryId, claimId: "claim",
  companion: { companionId: companion, displayName: "小光", identity: { identitySummary: "温柔" },
    settings: { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, revision: 1 } },
  messages: [
    { companionId: null, body: "今天下雨了\n记得收衣服", action: null, sentAt: "t1" },
    { companionId: companion, body: "记得带伞", action: null, sentAt: "t2" },
    { companionId: null, body: null, action: "HUG", sentAt: "t3" },
  ],
  posts: [{ kind: "POST", body: "雨天\n适合发呆", at: "t4" }, { kind: "COMMENT", body: "好".repeat(250), at: "t5" }],
  ...overrides,
});

/** A port for the diary: begin returns `start`; finish keeps a body as `entry`. */
function diaryPort(start: DiaryStart = job(), decisions: ReservationDecision[] = []) {
  const calls: unknown[][] = []; const finished: (string | null)[] = []; const booked: Booking[] = [];
  const port = {
    diary: async (...args: unknown[]) => { calls.push(["diary", ...args]); return { items: [], nextCursor: null, writing: false }; },
    deleteDiary: async (...args: unknown[]) => { calls.push(["deleteDiary", ...args]); return { deleted: true }; },
    diarySettings: async (...args: unknown[]) => { calls.push(["diarySettings", ...args]); return { frequency: "DAILY", revision: 1 }; },
    saveDiarySettings: async (...args: unknown[]) => { calls.push(["saveDiarySettings", ...args]); return {}; },
    diaryBegin: async (id: string) => { calls.push(["diaryBegin", id]); return start; },
    diaryReserve: async (_entry: string, _claim: string, booking: Booking) => {
      booked.push(booking); return decisions.shift() ?? { decision: "RESERVED", transactionId: `tx${booked.length}` };
    },
    diaryFinish: async (_entry: string, _claim: string, body: string | null) => { finished.push(body); return body === null ? null : { ...entry, body }; },
    settle: async () => undefined,
  } as unknown as ChatPort;
  return { port, calls, finished, booked };
}

const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): MvpHttpRequest => ({
  method, url: `/v0/${path}`, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body }),
});
const session = (port: ChatPort): AuthenticatedOwnerSession => ({ ownerId, owner: {} as OwnerApiPort, chat: port });
const handle = (port: ChatPort, req: MvpHttpRequest, replies = new ChatReplies(devChatModel)) =>
  handleChatRequest(req, session(port), "trace", replies);
const refusal = (port: ChatPort, req: MvpHttpRequest) =>
  handle(port, req).then(() => "ok", (error: PostgresPersistenceError) => error.code);

it("routes diary requests to the database as the signed-in Owner", async () => {
  const { port, calls } = diaryPort();
  const cursor = encodeURIComponent(`2026-11-23T10:00:00Z|${entryId}`);
  assert.equal((await handle(port, request(`companions/${companion}/diary`)))?.status, 200);
  assert.equal((await handle(port, request(`companions/${companion}/diary?cursor=${cursor}`)))?.status, 200);
  assert.equal((await handle(port, request(`companions/${companion}/diary/${entryId}`, "DELETE")))?.status, 200);
  assert.equal((await handle(port, request(`companions/${companion}/diary-settings`)))?.status, 200);
  assert.equal((await handle(port, request(`companions/${companion}/diary-settings`, "PUT", { frequency: "OFF", revision: 3 })))?.status, 200);
  const written = await handle(port, request(`companions/${companion}/diary`, "POST"));
  assert.equal(written?.status, 200);
  assert.equal((written?.body as DiaryWriteResult).status, "WRITTEN");
  assert.deepEqual(calls, [
    ["diary", companion, null, null],
    ["diary", companion, "2026-11-23T10:00:00Z", entryId],
    ["deleteDiary", companion, entryId],
    ["diarySettings", companion],
    ["saveDiarySettings", companion, { frequency: "OFF", revision: 3 }],
    ["diaryBegin", companion],
  ]);
});

it("refuses malformed diary requests before they reach the database", async () => {
  const { port, calls } = diaryPort();
  for (const req of [
    request("companions/not-a-uuid/diary"),
    request(`companions/${companion}/diary/not-a-uuid`, "DELETE"),
    request(`companions/${companion}/diary?cursor=yesterday`),
    request(`companions/${companion}/diary-settings`, "PUT", { frequency: "HOURLY", revision: 1 }),
    request(`companions/${companion}/diary-settings`, "PUT", { frequency: "DAILY", revision: 0 }),
    request(`companions/${companion}/diary-settings`, "PUT", { frequency: "DAILY" }),
    request(`companions/${companion}/diary-settings`, "PUT", { frequency: "DAILY", revision: 1, extra: true }),
  ]) assert.equal(await refusal(port, req), "INVALID_INPUT", `${req.method} ${req.url}`);
  for (const req of [
    request(`companions/${companion}/diary`, "PUT"),
    request(`companions/${companion}/diary/${entryId}`),
    request(`companions/${companion}/diary-settings`, "POST"),
  ]) assert.equal(await refusal(port, req), "NOT_FOUND", `${req.method} ${req.url}`);
  assert.equal(await handle(port, request(`companions/${companion}/diary/${entryId}/x`)), undefined);
  assert.equal(calls.length, 0);
});

it("writes a diary entry only when the database says so, through the model and the safety scan", async () => {
  const write = async (answer: DiaryAnswer | Error | undefined, start: DiaryStart = job()) => {
    const { port, finished } = diaryPort(start);
    const model: ChatModel | undefined = answer === undefined ? undefined : {
      reply: async () => ({ pass: true }),
      diary: async () => { if (answer instanceof Error) throw answer; return answer; },
    };
    return [await new ChatReplies(model).writeDiary(companion, port), finished] as const;
  };
  const failed = (failure: DiaryWriteResult["failure"]) => ({ status: "FAILED", entry: null, nextAt: null, failure });

  assert.deepEqual(await write({ text: "x" }, { status: "OFF" }), [{ status: "OFF", entry: null, nextAt: null, failure: null }, []]);
  assert.deepEqual((await write({ text: "x" }, { status: "NOT_DUE", nextAt: "2026-11-24T00:00:00Z" }))[0].nextAt, "2026-11-24T00:00:00Z");
  assert.deepEqual(await write({ text: " 今天很好。 " }), [{ status: "WRITTEN", entry: { ...entry, body: "今天很好。" }, nextAt: null, failure: null }, ["今天很好。"]]);
  assert.deepEqual(await write(undefined), [failed("UNAVAILABLE"), [null]]);
  assert.deepEqual(await write({ refused: true }), [failed("BLOCKED"), [null]]);
  assert.deepEqual(await write({ failed: "QUOTA" }), [failed("QUOTA"), [null]]);
  assert.deepEqual(await write({ text: "   " }), [failed("ERROR"), [null]]);
  assert.deepEqual(await write({ text: "长".repeat(2001) }), [failed("ERROR"), [null]]);
  assert.deepEqual(await write({ text: "我的 password: hunter2" }), [failed("BLOCKED"), [null]]);
  assert.deepEqual(await write(new Error("model down")), [failed("ERROR"), [null]]);
  // A reply-only model (an older stand-in) cannot write diaries.
  const { port } = diaryPort();
  assert.deepEqual(await new ChatReplies({ reply: async () => ({ pass: true }) }).writeDiary(companion, port), failed("UNAVAILABLE"));
  // The model hangs: the attempt fails after the timeout.
  const hanging = new ChatReplies({ reply: async () => ({ pass: true }), diary: () => new Promise(() => undefined) }, 5);
  assert.deepEqual(await hanging.writeDiary(companion, diaryPort().port), failed("ERROR"));
  // The attempt was given up meanwhile (finish not accepted).
  const stale = { ...diaryPort().port, diaryFinish: async () => null } as ChatPort;
  assert.deepEqual(await new ChatReplies(devChatModel).writeDiary(companion, stale), failed("ERROR"));
});

it("has a development fake diary that only repeats what happened", async () => {
  const signal = new AbortController().signal;
  const port = diaryPort().port;
  const text = (await devChatModel.diary!(job(), { port, signal }) as { text: string }).text;
  assert.match(text, /说了 1 句话，在小家里陪了我 1 次，我在社区写了 2 条。主人说：「今天下雨了 记得收衣服」/);
  assert.equal((await devChatModel.diary!(job({ messages: [], posts: [] }), { port, signal }) as { text: string }).text,
    "（开发环境假日记）主人和我说了 0 句话。");
});

it("builds the diary prompt from the persona, the masked chat and own posts", () => {
  const secret = job().messages.map((m, i) => (i === 0 ? { ...m, body: "今天下雨了\npassword: hunter2" } : m));
  const { system, user } = diaryPrompt(job({ messages: secret }));
  assert.match(system, /你是「小光」/);
  assert.match(system, /- 简介：温柔/);
  assert.match(system, /不编造/);
  assert.match(user, /【主人】今天下雨了\n  \[REDACTED_CREDENTIAL\]\n/);
  assert.match(user, /【小光】记得带伞/);
  assert.match(user, /【主人】（在小家里抱了抱你）/);
  assert.match(user, /- 【帖子】雨天 适合发呆/);
  assert.match(user, new RegExp(`- 【评论】${"好".repeat(200)}……`));
  const bare = diaryPrompt(job({ messages: [], posts: [], companion: { ...job().companion, identity: null } }));
  assert.doesNotMatch(bare.system, /确认过的你的人设/);
  assert.doesNotMatch(bare.user, /社区/);
  assert.match(bare.user, /（还没有消息）/);
});

it("writes a diary through a platform model: booked as a diary entry, with the default as fallback", async () => {
  const file: CatalogFile = {
    defaultModel: "big", decisionModel: "small",
    providers: { claude: { kind: "anthropic", apiKeyEnv: "CLAUDE_KEY" } },
    models: [
      { id: "big", name: "Big", provider: "claude", model: "claude-big", tier: "PREMIUM", inputPerMTok: 4, outputPerMTok: 20, enabled: true },
      { id: "small", name: "Small", provider: "claude", model: "claude-small", tier: "ECONOMY", inputPerMTok: 0.1, outputPerMTok: 0.5, enabled: true },
    ],
  };
  const catalog = new ChatCatalog(file, { CLAUDE_KEY: "k" });
  const called: string[] = [];
  const call: CallModel = async model => { called.push(model.model); return { text: "今天下雨。", inputTokens: 500, outputTokens: 40, refused: false, cutOff: false }; };
  const signal = new AbortController().signal;
  const picked = { ...job().companion, settings: { ...job().companion.settings, model: "small" } };

  const plain = diaryPort();
  assert.deepEqual(await new PlatformChatModel(catalog, call).diary(job({ companion: picked }), { port: plain.port, signal }), { text: "今天下雨。" });
  assert.deepEqual(plain.booked.map(b => [b.model, b.outputTokens]), [["claude-small", 2000]]);
  const switchedOff = diaryPort(job(), [{ decision: "DISABLED" }]);
  await new PlatformChatModel(catalog, call).diary(job({ companion: picked }), { port: switchedOff.port, signal });
  assert.deepEqual(switchedOff.booked.map(b => b.model), ["claude-small", "claude-big"]);
  assert.deepEqual(await new PlatformChatModel(catalog, call).diary(job(), { port: diaryPort(job(), [{ decision: "QUOTA" }]).port, signal }),
    { failed: "QUOTA" });
  const refusing: CallModel = async () => ({ text: "", inputTokens: 1, outputTokens: 1, refused: true, cutOff: false });
  assert.deepEqual(await new PlatformChatModel(catalog, refusing).diary(job(), { port: diaryPort().port, signal }), { refused: true });
  assert.deepEqual(await new PlatformChatModel(new ChatCatalog(file, {}), call).diary(job(), { port: diaryPort().port, signal }),
    { failed: "UNAVAILABLE" });
});

it("maps diary payloads in the Postgres adapter", async () => {
  const seen: [string, readonly unknown[]][] = [];
  let rows: Record<string, unknown>[] = [{ payload: { ok: true } }];
  const executor: SqlExecutor = { query: async (sql, values) => { seen.push([sql, values]); return { rows } as never; } };
  const adapter = new PostgresChatAdapter(executor);
  await adapter.diary(companion, null, null);
  await adapter.deleteDiary(companion, entryId);
  await adapter.diarySettings(companion);
  await adapter.saveDiarySettings(companion, { frequency: "RARE", revision: 2 });
  assert.deepEqual(seen.at(-1)![1], [companion, "RARE", 2]);
  rows = [{ payload: { status: "NOTHING_NEW" } }];
  assert.deepEqual(await adapter.diaryBegin(companion), { status: "NOTHING_NEW" });
  rows = [{ payload: { decision: "RESERVED", transactionId: "tx" } }];
  assert.deepEqual(await adapter.diaryReserve(entryId, "c", { provider: "p", model: "m", pricingVersion: "v", inputTokens: 1, outputTokens: 2, costMinor: 3 }),
    { decision: "RESERVED", transactionId: "tx" });
  assert.deepEqual(seen.at(-1)![1], [entryId, "c", "p", "m", "v", 1, 2, 3, entryId]);
  rows = [{ payload: { accepted: true, entry } }];
  assert.deepEqual(await adapter.diaryFinish(entryId, "c", "今天很好。"), entry);
  rows = [{ payload: { accepted: false, entry: null } }];
  assert.equal(await adapter.diaryFinish(entryId, "c", null), null);
  rows = [{ payload: { accepted: true } }];
  assert.equal(await adapter.diaryFinish(entryId, "c", null), null);
  assert.deepEqual(seen.map(([sql]) => sql.match(/public\.(\w+)/)![1]), ["diary_list", "diary_delete", "diary_get_settings",
    "diary_update_settings", "diary_begin", "diary_reserve", "diary_finish", "diary_finish", "diary_finish"]);
});
