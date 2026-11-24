import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { maskCredentials } from "../src/companion-import/policy.ts";
import { handleChatRequest } from "../src/chat/http.ts";
import { ChatCatalog, PRICING_VERSION, type CatalogFile } from "../src/chat/models.ts";
import { PlatformChatModel } from "../src/chat/platform.ts";
import type { ChatClaim, ChatPort, ChatReservation, ReservationDecision } from "../src/chat/port.ts";
import { PASS, decisionPrompt, parseDecision, parseReply, replyPrompt } from "../src/chat/prompt.ts";
import { createModelCaller, type CallModel, type ClaudeClient, type ModelRequest } from "../src/chat/providers.ts";
import { ChatReplies } from "../src/chat/replies.ts";
import { chatFromEnvironment } from "../src/chat/setup.ts";
import type { AuthenticatedOwnerSession, OwnerApiPort } from "../src/http/types.ts";

const file: CatalogFile = {
  defaultModel: "big",
  decisionModel: "small",
  providers: {
    claude: { kind: "anthropic", apiKeyEnv: "CLAUDE_KEY" },
    other: { kind: "openai-compatible", baseUrl: "https://llm.example/v1/", apiKeyEnv: "OTHER_KEY" },
  },
  models: [
    { id: "big", name: "Big", provider: "claude", model: "claude-big", tier: "PREMIUM", inputPerMTok: 4, outputPerMTok: 20, enabled: true,
      options: { effort: "low", fallbacks: true } },
    { id: "small", name: "Small", provider: "claude", model: "claude-small", tier: "ECONOMY", inputPerMTok: 0.1, outputPerMTok: 0.5, enabled: true,
      options: { thinking: "disabled" } },
    { id: "cheap", name: "Cheap", provider: "other", model: "other-chat", tier: "ECONOMY", inputPerMTok: 0.2, outputPerMTok: 0.8, enabled: true,
      options: { maxTokensParam: "max_completion_tokens" } },
    { id: "off", name: "Off", provider: "other", model: "other-off", tier: "STANDARD", inputPerMTok: 1, outputPerMTok: 1, enabled: false },
  ],
};
const keys = { CLAUDE_KEY: "ck", OTHER_KEY: " ok " };
const owner = "00000000-0000-0000-0000-0000000001a1";
const me = "00000000-0000-0000-0000-0000000002a1";
const friend = "00000000-0000-0000-0000-0000000002a2";

const turn = (overrides: Partial<ChatClaim> = {}): ChatClaim => ({
  chatId: "chat", replyId: "reply", claimId: "claim", replyTo: "OWNER", optional: false, direct: false,
  companion: { companionId: me, displayName: "小光", settings: { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, revision: 1 },
    identity: { identitySummary: "温柔\n爱笑", personaTraits: ["细心", ["幽默"]], speakingStyle: { 语气: "轻松", empty: null }, boundaries: [], unknown: "x" } },
  members: [{ companionId: me, displayName: "小光" }, { companionId: friend, displayName: "阿默" }],
  history: [
    { companionId: friend, body: "早", action: null, mentions: [], sentAt: "t1" },
    { companionId: null, body: "大家好\napi_key: sk-abcdefghijklmnopqrstu", action: null, mentions: [], sentAt: "t2" },
  ],
  ...overrides,
});

it("loads and checks the catalog, and picks a usable model", () => {
  const catalog = new ChatCatalog(file, keys);
  assert.deepEqual([catalog.pick(null)?.id, catalog.pick("cheap")?.id, catalog.pick("off")?.id, catalog.pick("nope")?.id], ["big", "cheap", "big", "big"]);
  assert.equal(catalog.decisionModel()?.id, "small");
  assert.equal(catalog.apiKey(catalog.models[2]!), "ok");
  assert.deepEqual([catalog.has("off"), catalog.has("nope")], [true, false]);
  assert.equal(catalog.cost(catalog.models[0]!, 10_000, 2_000), 8); // 4 + 4 cents
  assert.equal(catalog.cost(catalog.models[1]!, 100, 10), 0.0015, "fractions of a cent; rounding is the caller's");
  assert.equal(new ChatCatalog(file, { OTHER_KEY: "k" }).pick(null)?.id, "cheap", "default without a key: first usable model");
  const keyless = new ChatCatalog(file, {});
  assert.deepEqual([keyless.pick(null), keyless.defaultModel(), keyless.decisionModel()], [undefined, undefined, undefined]);
  assert.equal(new ChatCatalog({ ...file, decisionModel: null }, keys).decisionModel(), undefined);
  const broken: [Partial<CatalogFile> | unknown, RegExp][] = [
    [null, /needs providers/],
    [{ ...file, providers: { x: { kind: "magic", apiKeyEnv: "K" } } }, /unknown kind/],
    [{ ...file, providers: { x: { kind: "openai-compatible", baseUrl: "http://plain", apiKeyEnv: "K" } } }, /https baseUrl/],
    [{ ...file, providers: { ...file.providers, x: { kind: "anthropic", apiKeyEnv: "lower" } } }, /apiKeyEnv/],
    [{ ...file, models: [...file.models, file.models[0]!] }, /repeated/],
    [{ ...file, models: [{ ...file.models[0]!, provider: "ghost" }] }, /unknown provider/],
    [{ ...file, models: [{ ...file.models[0]!, name: "" }] }, /needs name/],
    [{ ...file, models: [{ ...file.models[0]!, tier: "GOLD" }] }, /unknown tier/],
    [{ ...file, models: [{ ...file.models[0]!, inputPerMTok: -1 }] }, /needs prices/],
    [{ ...file, models: [{ ...file.models[0]!, enabled: "yes" }] }, /needs enabled/],
    [{ ...file, defaultModel: "ghost" }, /defaultModel/],
    [{ ...file, decisionModel: "ghost" }, /decisionModel/],
  ];
  for (const [bad, message] of broken) assert.throws(() => new ChatCatalog(bad as CatalogFile, keys), message);
});

it("loads the shipped catalog and a file named by CHAT_MODELS_FILE", () => {
  const shipped = ChatCatalog.load({});
  assert.ok(shipped.has(shipped.models[0]!.id));
  assert.equal(shipped.pick(null), undefined, "no key, nothing usable");
  const dir = mkdtempSync(path.join(tmpdir(), "chat-models-"));
  writeFileSync(path.join(dir, "models.json"), JSON.stringify(file));
  assert.equal(ChatCatalog.load({ CHAT_MODELS_FILE: path.join(dir, "models.json"), ...keys }).pick(null)?.id, "big");
});

it("builds prompts with the persona, the setting and a masked, bounded transcript", () => {
  const { system, user } = replyPrompt(turn());
  assert.match(system, /你是「小光」/);
  assert.match(system, /- 简介：温柔 爱笑/);
  assert.match(system, /- 性格：细心、幽默/);
  assert.match(system, /- 说话风格：语气：轻松/);
  assert.doesNotMatch(system, /边界|unknown/);
  assert.match(user, /群聊里，群里有主人和阿默。你在群聊里的活跃度是「适中/);
  assert.match(user, /【阿默】早\n【主人】大家好\n {2}\[REDACTED_CREDENTIAL\]/);
  assert.match(user, /现在轮到你（小光）说话。$/);
  assert.match(replyPrompt(turn({ optional: true })).user, new RegExp(`只输出 \\${PASS.slice(0, -1)}`));
  assert.match(replyPrompt(turn({ direct: true, history: [] })).user, /一对一私聊。[\s\S]*（还没有消息）/);
  assert.match(replyPrompt(turn({ members: [{ companionId: me, displayName: "小光" }] })).user, /群里有主人。/);
  assert.equal(replyPrompt(turn({ companion: { ...turn().companion, identity: null } })).system.includes("确认过的你的人设"), false);
  const long = Array.from({ length: 40 }, (_, i) => ({ companionId: null, body: `${i}`.padEnd(400, "字"), action: null, mentions: [], sentAt: `${i}` }));
  const bounded = replyPrompt(turn({ history: long })).user;
  assert.ok(bounded.length < 9_000 && bounded.includes("【主人】39") && !bounded.includes("【主人】0字"), "newest kept, oldest dropped");
  assert.match(replyPrompt(turn({ history: [{ companionId: "ghost", body: "?", action: null, mentions: [], sentAt: "t" }] })).user, /【某位家机】/);
  const decide = decisionPrompt(turn());
  assert.match(decide.system, /只回答一个字：是 或 否/);
  assert.match(decide.user, /最后的消息需要「小光」回应吗？$/);
});

it("tells the model about home-room actions and lets it stay quiet", () => {
  const acted = turn({ direct: true, optional: true, history: [
    { companionId: null, body: "晚安", action: null, mentions: [], sentAt: "t1" },
    { companionId: null, body: null, action: "PAT_HEAD", mentions: [], sentAt: "t2" },
  ] });
  const { user } = replyPrompt(acted);
  assert.match(user, /【主人】晚安\n【主人】（在小家里摸了摸你的头）/);
  assert.match(user, /主人刚才对你做了个小动作[\s\S]*不刻意讨好/);
  assert.match(user, new RegExp(`只输出 \\${PASS.slice(0, -1)}`));
  const decide = decisionPrompt(acted);
  assert.match(decide.system, /主人刚在小家里对它做了个小动作/);
  assert.match(decide.user, /（在小家里摸了摸你的头）[\s\S]*「小光」要回一句话吗？$/);
  // Later turns that must answer still see the action in the transcript.
  assert.match(replyPrompt({ ...acted, optional: false }).user, /（在小家里摸了摸你的头）\n\n现在轮到你（小光）说话。$/);
});

it("reads the model's answer: lines, name prefixes, passes and decisions", () => {
  assert.deepEqual(parseReply("小光：好呀\n\n【小光】我也想去\n", "小光"), { messages: ["好呀", "我也想去"] });
  assert.deepEqual(parseReply(` ${PASS}。`, "小光"), { pass: true });
  assert.deepEqual(parseReply("   ", "小光"), { pass: true });
  assert.deepEqual(parseReply("a.b：x", "a.b"), { messages: ["x"] }, "names are matched literally");
  for (const yes of ["是", "要的", "Yes."]) assert.equal(parseDecision(yes), true);
  for (const no of ["否", "不需要", "no", ""]) assert.equal(parseDecision(no), false);
  assert.equal(maskCredentials("password = hunter2 and gho_abcdefghijklmnopqrstuvwxyz"), "[REDACTED_CREDENTIAL] and [REDACTED_CREDENTIAL]");
});

it("calls Claude through the SDK and OpenAI-style providers over HTTP", async () => {
  const catalog = new ChatCatalog(file, keys);
  const sent: unknown[] = []; let made = 0;
  const claude = (): ClaudeClient => { made += 1; return { beta: { messages: { create: async (params: unknown, options: unknown) => {
    sent.push(params, options);
    return { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "你" }, { type: "text", text: "好" }], stop_reason: "end_turn",
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: null, output_tokens: 3 } };
  } } } } as unknown as ClaudeClient; };
  const fetched: [string, RequestInit][] = [];
  let reply: Response = Response.json({ choices: [{ message: { content: "嗨" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
  const fetcher = (async (url: string, init: RequestInit) => { fetched.push([url, init]); return reply; }) as unknown as typeof fetch;
  const call = createModelCaller(catalog, { claude, fetch: fetcher });
  const request: ModelRequest = { system: "S", user: "U", maxTokens: 50, signal: new AbortController().signal };

  assert.deepEqual(await call(catalog.models[0]!, request), { text: "你好", inputTokens: 10, outputTokens: 3, refused: false, cutOff: false });
  await call(catalog.models[1]!, request);
  assert.equal(made, 1, "one Claude client per key");
  const [big, options, small] = sent as Record<string, unknown>[];
  assert.deepEqual(big, { model: "claude-big", max_tokens: 50, system: "S",
    messages: [{ role: "user", content: "U" }], output_config: { effort: "low" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  assert.equal(options!.signal, request.signal);
  assert.deepEqual(small!.thinking, { type: "disabled" });

  assert.deepEqual(await call(catalog.models[2]!, request), { text: "嗨", inputTokens: 7, outputTokens: 2, refused: false, cutOff: false });
  const [url, init] = fetched[0]!;
  assert.equal(url, "https://llm.example/v1/chat/completions");
  assert.equal((init.headers as Record<string, string>).authorization, "Bearer ok");
  assert.deepEqual(JSON.parse(init.body as string), { model: "other-chat", max_completion_tokens: 50,
    messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] });
  reply = Response.json({ choices: [{ message: { content: null }, finish_reason: "content_filter" }] });
  assert.deepEqual(await call(catalog.models[2]!, request), { text: "", inputTokens: 0, outputTokens: 0, refused: true, cutOff: false });
  reply = Response.json({ choices: [{ message: { content: "说到一半" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 50 } });
  assert.equal((await call(catalog.models[2]!, request)).cutOff, true);
  reply = new Response("busy", { status: 503 });
  await assert.rejects(call(catalog.models[2]!, request), /HTTP 503/);
  await assert.rejects(createModelCaller(new ChatCatalog(file, {}))(catalog.models[0]!, request), /no API key/);
});

/** A port that books calls and records settlements; `decisions` are returned by reserve in order. */
function bookingPort(decisions: ReservationDecision[] = []) {
  const reserved: ChatReservation[] = []; const settled: unknown[][] = [];
  const port = {
    reserve: async (input: ChatReservation) => { reserved.push(input); return decisions.shift() ?? { decision: "RESERVED", transactionId: `tx${reserved.length}` }; },
    settle: async (...args: unknown[]) => { settled.push(args); },
    memories: async () => ({ items: [{ body: "主人喜欢下雨天" }, { body: "password: hunter2hunter2" }] }),
  } as unknown as ChatPort;
  return { port, reserved, settled };
}

it("speaks through a platform model: books, calls, settles, and asks the cheap model first when optional", async () => {
  const catalog = new ChatCatalog(file, keys);
  const calls: string[] = []; const systems: string[] = [];
  const answers: Record<string, string> = { "claude-small": "否", "claude-big": "好呀\n走吧" };
  const call: CallModel = async (model, request) => {
    calls.push(model.model); systems.push(request.system);
    return { text: answers[model.model]!, inputTokens: request.user.length, outputTokens: 4, refused: false, cutOff: false };
  };
  const platform = new PlatformChatModel(catalog, call);
  const signal = new AbortController().signal;

  const { port, reserved, settled } = bookingPort();
  assert.deepEqual(await platform.reply(turn(), { port, signal }), { messages: ["好呀", "走吧"] });
  assert.deepEqual(calls, ["claude-big"]);
  assert.match(systems[0]!, /你记得的事[^]*- 主人喜欢下雨天\n- \[REDACTED_CREDENTIAL\]/, "memories, newest first, credentials masked");
  assert.deepEqual({ ...reserved[0], inputTokens: 0, costMinor: 0 }, { replyId: "reply", claimId: "claim", purpose: "REPLY", provider: "claude",
    model: "claude-big", pricingVersion: PRICING_VERSION, inputTokens: 0, outputTokens: 2000, costMinor: 0, traceId: "reply" });
  assert.equal(settled[0]![0], "tx1");
  assert.equal(settled[0]![4], true);

  calls.length = 0;
  assert.deepEqual(await platform.reply(turn({ optional: true }), bookingPort().port && { port, signal }), { pass: true });
  assert.deepEqual(calls, ["claude-small"], "a no from the cheap model costs no reply");
  answers["claude-small"] = "是";
  assert.deepEqual(await platform.reply(turn({ optional: true }), { port, signal }), { messages: ["好呀", "走吧"] });
  assert.deepEqual(reserved.slice(-2).map(r => [r.purpose, r.outputTokens]), [["DECIDE", 100], ["REPLY", 2000]]);

  const chosen = turn({ companion: { ...turn().companion, settings: { ...turn().companion.settings, model: "cheap" } } });
  answers["other-chat"] = PASS;
  assert.deepEqual(await platform.reply(chosen, { port, signal }), { pass: true });
  answers["claude-big"] = "";
  const refusing: CallModel = async () => ({ text: "", inputTokens: 1, outputTokens: 0, refused: true, cutOff: false });
  assert.deepEqual(await new PlatformChatModel(catalog, refusing).reply(turn(), { port, signal }), { refused: true });
  assert.deepEqual(await new PlatformChatModel(catalog, refusing).reply(turn({ optional: true }), { port, signal }), { pass: true });

  // The chosen model is switched off: the default answers instead (a DISABLED reservation books nothing).
  answers["claude-big"] = "换了模型";
  const fallingBack = bookingPort([{ decision: "DISABLED" }]);
  assert.deepEqual(await platform.reply(chosen, { port: fallingBack.port, signal }), { messages: ["换了模型"] });
  assert.deepEqual(fallingBack.reserved.map(r => r.model), ["other-chat", "claude-big"]);
  answers["claude-big"] = "";
  for (const decision of ["QUOTA", "DISABLED"] as const) {
    assert.deepEqual(await platform.reply(turn(), { port: bookingPort([{ decision }]).port, signal }), { failed: decision });
    assert.deepEqual(await platform.reply(turn({ optional: true }), { port: bookingPort([{ decision }]).port, signal }), { pass: true });
  }
  // The judge is switched off: the reply model is asked instead of the turn going quiet for good.
  answers["claude-big"] = "我在";
  const judgeOff = bookingPort([{ decision: "DISABLED" }]);
  assert.deepEqual(await platform.reply(turn({ optional: true }), { port: judgeOff.port, signal }), { messages: ["我在"] });
  assert.deepEqual(judgeOff.reserved.map(r => r.purpose), ["DECIDE", "REPLY"]);
  answers["claude-big"] = "";
  await assert.rejects(platform.reply(turn(), { port: bookingPort([{ decision: "STALE" }]).port, signal }), /moved on/);
  assert.deepEqual(await new PlatformChatModel(new ChatCatalog(file, {}), call).reply(turn(), { port, signal }), { failed: "UNAVAILABLE" });
  const noJudge = new PlatformChatModel(new ChatCatalog({ ...file, decisionModel: null }, keys), call);
  answers["claude-big"] = PASS;
  assert.deepEqual(await noJudge.reply(turn({ optional: true }), { port, signal }), { pass: true }, "without a judge the reply model decides");

  // No usage reported: charged the reservation. Cut off at the limit: settled with real usage, then the turn fails.
  const silent = bookingPort();
  await new PlatformChatModel(catalog, async () => ({ text: "嗯", inputTokens: 0, outputTokens: 0, refused: false, cutOff: false }))
    .reply(turn(), { port: silent.port, signal });
  assert.deepEqual(silent.settled[0]!.slice(1), [silent.reserved[0]!.inputTokens, 2000, silent.reserved[0]!.costMinor, true]);
  const cut = bookingPort();
  await assert.rejects(new PlatformChatModel(catalog, async () => ({ text: "说到一", inputTokens: 900, outputTokens: 2000, refused: false, cutOff: true }))
    .reply(turn(), { port: cut.port, signal }), /cut off/);
  assert.deepEqual(cut.settled[0]!.slice(1), [900, 2000, 4, true], "900 in + 2000 out on Big = 4.36 cents, rounded to 4");
  // Cheap calls round to zero cents at settlement, so they do not each eat a cent of the daily budget.
  const cheap = bookingPort();
  await new PlatformChatModel(catalog, async () => ({ text: "是", inputTokens: 300, outputTokens: 1, refused: false, cutOff: false }))
    .reply(turn({ optional: true }), { port: cheap.port, signal });
  assert.deepEqual([cheap.reserved[0]!.purpose, cheap.reserved[0]!.costMinor, cheap.settled[0]![3]], ["DECIDE", 1, 0]);

  const failing = bookingPort();
  await assert.rejects(new PlatformChatModel(catalog, async () => { throw new Error("down"); }).reply(turn(), { port: failing.port, signal }), /down/);
  const [, inputTokens, outputTokens, cost, ok] = failing.settled[0]!;
  assert.deepEqual([outputTokens, ok], [2000, false], "a failed call is charged its reservation");
  assert.ok((inputTokens as number) > 0 && (cost as number) >= 1);

  // Through the reply writer: a model answer becomes SENT messages.
  const finished: unknown[] = [];
  const writerPort = { ...port, claim: async () => (finished.length === 0 ? turn() : null),
    finish: async (...args: unknown[]) => { finished.push(args); return true; } } as unknown as ChatPort;
  answers["claude-big"] = "嗯";
  await new ChatReplies(platform).drain("chat", writerPort);
  assert.deepEqual(finished, [["reply", "claim", "SENT", ["嗯"]]]);
});

it("lists models with availability and checks the Owner's choice", async () => {
  const catalog = new ChatCatalog(file, keys);
  const saved: unknown[] = [];
  const port = { modelsEnabled: async (models: { provider: string }[]) => models.map(m => m.provider !== "other"),
    settings: async () => ({ voice: "kept" }),
    saveSettings: async (_id: string, settings: unknown) => { saved.push(settings); return settings; } } as unknown as ChatPort;
  const session = { ownerId: owner, owner: {} as OwnerApiPort, chat: port } as AuthenticatedOwnerSession;
  const replies = new ChatReplies();
  const get = (url: string, method = "GET", body?: unknown) => handleChatRequest({ method, url,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body }) }, session, "t", replies, catalog);
  const listed = (await get("/v0/chat-models"))!;
  assert.deepEqual(listed.body, { defaultModel: "big", items: [
    { id: "big", name: "Big", provider: "claude", tier: "PREMIUM", inputPerMTok: 4, outputPerMTok: 20, available: true },
    { id: "small", name: "Small", provider: "claude", tier: "ECONOMY", inputPerMTok: 0.1, outputPerMTok: 0.5, available: true },
    { id: "cheap", name: "Cheap", provider: "other", tier: "ECONOMY", inputPerMTok: 0.2, outputPerMTok: 0.8, available: false },
    { id: "off", name: "Off", provider: "other", tier: "STANDARD", inputPerMTok: 1, outputPerMTok: 1, available: false },
  ] });
  const allOff = { ...port, modelsEnabled: async (models: unknown[]) => models.map(() => false) } as ChatPort;
  const off = await handleChatRequest({ method: "GET", url: "/v0/chat-models" }, { ...session, chat: allOff }, "t", replies, catalog);
  assert.equal((off!.body as { defaultModel: unknown }).defaultModel, null);
  assert.deepEqual((await handleChatRequest({ method: "GET", url: "/v0/chat-models" }, session, "t", replies))!.body, { items: [], defaultModel: null });
  await assert.rejects(get("/v0/chat-models", "POST"), { code: "NOT_FOUND" });
  const put = { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: "cheap", revision: 1 };
  assert.equal((await get(`/v0/companions/${me}/chat-settings`, "PUT", put))!.status, 200);
  assert.deepEqual(saved, [{ ...put, voice: "kept" }], "any catalog model may be chosen, even one not usable right now");
  await assert.rejects(get(`/v0/companions/${me}/chat-settings`, "PUT", { ...put, model: "ghost" }), { code: "INVALID_INPUT" });
});

it("sets up chat from the environment: platform models with a key, otherwise the dev fake or nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "chat-setup-"));
  writeFileSync(path.join(dir, "models.json"), JSON.stringify(file));
  const env = { CHAT_MODELS_FILE: path.join(dir, "models.json") };
  for (const [mode, withKeys] of [["stage1-mobile-dev", true], ["stage1-mobile-dev", false], ["supabase-auth", false]] as const) {
    const chat = chatFromEnvironment(mode, withKeys ? { ...env, ...keys } : env);
    assert.ok(chat.catalog.has("big") && chat.replies instanceof ChatReplies);
    assert.deepEqual(chat.background, withKeys ? { platform: true } : undefined, "background diaries need a real model");
  }
  const ownKeys = chatFromEnvironment("supabase-auth", { ...env, CONNECTION_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") });
  assert.deepEqual(ownKeys.background, { platform: false }, "only Owners' own keys and agents");
});
