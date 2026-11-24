import assert from "node:assert/strict";
import { it } from "node:test";
import { handleChatRequest } from "../src/chat/http.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import { agentMessages, replyPrompt, splitVoice } from "../src/chat/prompt.ts";
import { ChatReplies, devChatModel, type ChatModel } from "../src/chat/replies.ts";
import {
  devSpeaker, MiniMaxSpeaker, VoiceCatalog, Voices, type Clip, type Emotion, type Speaker, type VoiceFile,
} from "../src/chat/voices.ts";
import type { ChatClaim, ChatOutcome, ChatPort } from "../src/chat/port.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, OwnerApiPort } from "../src/http/types.ts";
import type { SqlExecutor } from "../src/persistence/postgres/types.ts";

const chatId = "00000000-0000-0000-0000-00000000c001";
const companion = "00000000-0000-0000-0000-0000000002a1";
const messageId = "00000000-0000-0000-0000-00000000d001";

const file: VoiceFile = {
  provider: { kind: "minimax", baseUrl: "https://speech.example/", apiKeyEnv: "SPEECH_KEY", model: "speech-x" },
  sampleText: "你好呀",
  voices: [
    { id: "warm", name: "暖暖", gender: "FEMALE", description: "温暖", providerVoice: "Provider_Warm" },
    { id: "calm-boy", name: "阿静", gender: "MALE", description: "安静", providerVoice: "Provider_Calm" },
  ],
};
const catalog = new VoiceCatalog(file, { SPEECH_KEY: " key " });
const clip = (text: string): Clip => ({ bytes: new TextEncoder().encode(text), mime: "audio/mpeg", durationMs: 1000 * Array.from(text).length, characters: 2 });

/** Says the text back as its bytes and records what it was asked. */
function recordingSpeaker(fail: (text: string) => boolean = () => false) {
  const said: [string, string, Emotion | null][] = [];
  const speaker: Speaker = {
    async speak(text, voice, emotion) {
      said.push([text, voice.id, emotion]);
      if (fail(text)) throw new Error("provider down");
      return clip(text);
    },
  };
  return { speaker, said };
}

const settings = (voice: string | null) => ({ groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, voice, revision: 1 }) as const;
const turn = (voice: string | null): ChatClaim => ({
  chatId, replyId: messageId, claimId: "claim", replyTo: "OWNER", optional: false, direct: true,
  companion: { companionId: companion, displayName: "小光", identity: {}, settings: settings(voice) },
  members: [{ companionId: companion, displayName: "小光" }],
  history: [{ companionId: null, body: "我回来了", action: null, mentions: [], sentAt: "2026-11-24T10:00:00Z" }],
});

/** A port for writing replies: claim hands out one turn, finish records what was stored. */
function replyPort(claim: ChatClaim, left = 60) {
  const finished: [ChatOutcome, string[] | null, (Clip | null)[] | undefined][] = [];
  const port = {
    claim: async () => { const next = claimed ? null : claim; claimed = true; return next; },
    finish: async (_reply: string, _claim: string, outcome: ChatOutcome, bodies: string[] | null, clips?: (Clip | null)[]) => {
      finished.push([outcome, bodies, clips]); return true;
    },
    voiceLeft: async () => { if (left < 0) throw new Error("db down"); return left; },
    memories: async () => ({ items: [] }),
  } as unknown as ChatPort;
  let claimed = false;
  return { port, finished };
}

const says = (...messages: string[]): ChatModel => ({ reply: async () => ({ messages }) });

it("loads the voice catalog and refuses a broken one", () => {
  const shipped = VoiceCatalog.load({});
  assert.ok(shipped.voices.length >= 6, "the shipped voices.json is valid");
  assert.equal(shipped.apiKey(), undefined);
  assert.equal(catalog.apiKey(), "key");
  assert.equal(catalog.find("warm")?.name, "暖暖");
  assert.equal(catalog.find(null), undefined);
  assert.equal(catalog.sampleText, "你好呀");
  const broken: [string, unknown][] = [
    ["minimax provider", { ...file, provider: { ...file.provider, kind: "other" } }],
    ["minimax provider", { voices: [] }],
    ["https baseUrl", { ...file, provider: { ...file.provider, baseUrl: "http://x" } }],
    ["apiKeyEnv", { ...file, provider: { ...file.provider, apiKeyEnv: "lower" } }],
    ["needs a model", { ...file, provider: { ...file.provider, model: "" } }],
    ["sampleText", { ...file, sampleText: " " }],
    ["needs voices", { ...file, voices: undefined }],
    ["invalid or repeated", { ...file, voices: [file.voices[0], file.voices[0]] }],
    ["invalid or repeated", { ...file, voices: [{ ...file.voices[0], id: "Big" }] }],
    ["gender", { ...file, voices: [{ ...file.voices[0], gender: "X" }] }],
    ["needs providerVoice", { ...file, voices: [{ ...file.voices[0], providerVoice: "" }] }],
  ];
  for (const [message, value] of broken) assert.throws(() => new VoiceCatalog(value as VoiceFile), new RegExp(message));
});

it("asks MiniMax for speech and reads its answer", async () => {
  const requests: [string, RequestInit][] = [];
  const answer = (status: number, payload: unknown) => (async (url: string, init: RequestInit) => {
    requests.push([url, init]);
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  const ok = { data: { audio: "fff3" }, extra_info: { audio_length: 1200, usage_characters: 28 }, base_resp: { status_code: 0 } };
  const speaker = new MiniMaxSpeaker(file.provider, "secret", answer(200, ok));
  const signal = new AbortController().signal;
  assert.deepEqual(await speaker.speak("你好", file.voices[0]!, "happy", signal),
    { bytes: Buffer.from([0xff, 0xf3]), mime: "audio/mpeg", durationMs: 1200, characters: 28 });
  const [url, init] = requests[0]!;
  assert.equal(url, "https://speech.example/v1/t2a_v2");
  assert.equal((init.headers as Record<string, string>).authorization, "Bearer secret");
  const sent = JSON.parse(init.body as string);
  assert.equal(sent.model, "speech-x");
  assert.deepEqual(sent.voice_setting, { voice_id: "Provider_Warm", speed: 1, vol: 1, pitch: 0, emotion: "happy" });
  assert.equal(init.signal, signal);
  await speaker.speak("你好", file.voices[0]!, null, signal);
  assert.equal(JSON.parse(requests[1]![1].body as string).voice_setting.emotion, undefined, "no tone: the provider picks one");

  const noUsage = { ...ok, extra_info: { audio_length: 5 } };
  assert.equal((await new MiniMaxSpeaker(file.provider, "k", answer(200, noUsage)).speak("a", file.voices[0]!, null, signal)).characters, 0);
  const failures: [number, unknown, RegExp][] = [
    [500, {}, /HTTP 500/],
    [200, { base_resp: { status_code: 1008, status_msg: "insufficient balance" } }, /1008 insufficient balance/],
    [200, { base_resp: { status_code: 0 }, data: { audio: "xyz" }, extra_info: { audio_length: 1 } }, /unexpected shape/],
    [200, { base_resp: { status_code: 0 }, data: { audio: "fff" }, extra_info: { audio_length: 1 } }, /unexpected shape/],
    [200, { base_resp: { status_code: 0 }, data: { audio: "ff" }, extra_info: { audio_length: 0 } }, /unexpected shape/],
    [200, { base_resp: { status_code: 0 }, data: {}, extra_info: {} }, /unexpected shape/],
  ];
  for (const [status, payload, message] of failures) {
    await assert.rejects(new MiniMaxSpeaker(file.provider, "k", answer(status, payload)).speak("a", file.voices[0]!, null, signal), message);
  }
});

it("speaks silence on the dev host and nothing on a host without a key", async () => {
  const silence = await devSpeaker.speak("你好", file.voices[0]!, null, new AbortController().signal);
  assert.equal(silence.mime, "audio/wav");
  assert.equal(silence.durationMs, 900);
  assert.equal(Buffer.from(silence.bytes).toString("latin1", 0, 4), "RIFF");
  assert.equal(silence.bytes.length, 44 + 7200);
  assert.equal((await devSpeaker.speak("长".repeat(100), file.voices[0]!, null, new AbortController().signal)).durationMs, 8000);

  const env = { VOICES_FILE: undefined };
  assert.equal(Voices.fromEnvironment("supabase-auth", env).available, false);
  assert.equal(Voices.fromEnvironment("supabase-auth", env).pick("warm-girl"), undefined);
  assert.equal(Voices.fromEnvironment("stage1-mobile-dev", env).pick("warm-girl")?.id, "warm-girl");
  assert.equal(Voices.fromEnvironment("supabase-auth", { MINIMAX_API_KEY: "k" }).available, true);
  await assert.rejects(new Voices(catalog).speak("a", file.voices[0]!, null, new AbortController().signal), /no speech provider/);
});

it("makes each sample once and tries again after a failure", async () => {
  let calls = 0;
  const voices = new Voices(catalog, { speak: async text => { calls += 1; if (calls === 1) throw new Error("down"); return clip(text); } });
  await assert.rejects(voices.sample(file.voices[0]!), /down/);
  const [a, b] = await Promise.all([voices.sample(file.voices[0]!), voices.sample(file.voices[0]!)]);
  assert.equal(a, b);
  assert.equal(calls, 2);
  assert.equal(new TextDecoder().decode(a.bytes), "你好呀");
});

it("reads voice marks and tells the model about them only when the Companion has a voice", () => {
  assert.deepEqual(splitVoice("[语音]你好"), { text: "你好", voice: null });
  assert.deepEqual(splitVoice("[语音:开心] 你回来啦"), { text: "你回来啦", voice: "happy" });
  assert.deepEqual(splitVoice("[语音：难过]唉"), { text: "唉", voice: "sad" });
  assert.deepEqual(splitVoice("[语音:跳舞]嗯"), { text: "嗯", voice: null }, "an unknown tone is no tone");
  assert.deepEqual(splitVoice("我说[语音]"), { text: "我说[语音]", voice: false });
  assert.match(replyPrompt(turn("warm")).system, /\[语音:开心\]/);
  assert.doesNotMatch(replyPrompt(turn(null)).system, /语音/);
  assert.match(agentMessages(turn("warm"))[0]!.content, /\[语音\]/);
});

it("says the marked messages in the Companion's voice and keeps the rest as text", async () => {
  const { speaker, said } = recordingSpeaker();
  const replies = new ChatReplies(says("[语音:开心]你回来啦", "今天做了什么？", "[语音]抱抱"), undefined, new Voices(catalog, speaker));
  const { port, finished } = replyPort(turn("warm"));
  assert.equal(await replies.drain(chatId, port), 1);
  assert.deepEqual(said, [["你回来啦", "warm", "happy"], ["抱抱", "warm", null]]);
  assert.deepEqual(finished, [["SENT", ["你回来啦", "今天做了什么？", "抱抱"], [clip("你回来啦"), null, clip("抱抱")]]]);
  assert.equal(replies.voices?.available, true);
});

it("falls back to text when a voice message cannot be made", async () => {
  const run = async (model: ChatModel, claim: ChatClaim, speaker: Speaker | undefined, left = 60, timeoutMs?: number) => {
    const { port, finished } = replyPort(claim, left);
    const voices = speaker === undefined ? undefined : new Voices(catalog, speaker);
    await new ChatReplies(model, undefined, voices, timeoutMs).drain(chatId, port);
    return finished[0]!;
  };
  const text = (...bodies: string[]) => ["SENT", bodies, undefined];
  const { speaker, said } = recordingSpeaker(t => t === "坏");
  assert.deepEqual(await run(says("[语音]好", "[语音]坏"), turn("warm"), speaker), ["SENT", ["好", "坏"], [clip("好"), null]],
    "a failed clip is text");
  assert.deepEqual(await run(says("[语音]坏"), turn("warm"), speaker), text("坏"), "all failed: plain text");
  assert.deepEqual(await run(says("[语音]一", "[语音]二"), turn("warm"), speaker, 1), ["SENT", ["一", "二"], [clip("一"), null]],
    "only as many as today's voice messages left");
  assert.deepEqual(await run(says("[语音]一"), turn("warm"), speaker, -1), text("一"), "the count could not be read");
  assert.deepEqual(await run(says(`[语音]${"长".repeat(121)}`), turn("warm"), speaker), text("长".repeat(121)), "too long to say");
  assert.deepEqual(await run(says("[语音]一", "二", "[语音]三", "[语音]四"), turn("warm"), speaker),
    ["SENT", ["一", "二", "三\n四"], [clip("一"), null, null]], "joined messages are text");
  assert.deepEqual(await run(says("[语音:开心]你好"), turn(null), speaker), text("你好"), "no voice chosen: the mark is dropped");
  assert.deepEqual(await run(says("[语音]", "嗯"), turn("warm"), speaker), text("嗯"), "a mark alone is nothing");
  assert.deepEqual(await run(says("[语音]手机 13800138000", "[语音]记一下"), turn("warm"), speaker),
    ["SENT", ["手机 [REDACTED_PII]", "记一下"], [null, clip("记一下")]], "what the safety scan changed is text");
  const hanging: Speaker = { speak: (_t, _v, _e, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) };
  assert.deepEqual(await run(says("[语音]嗯"), turn("warm"), hanging, 60, 5), text("嗯"), "too slow: text");
  assert.equal(said.filter(([t]) => t === "二").length, 0);

  let seen: ChatClaim | undefined;
  const watcher: ChatModel = { reply: async claim => { seen = claim; return { messages: ["[语音]嗯"] }; } };
  assert.deepEqual(await run(watcher, turn("warm"), undefined), text("嗯"), "no voices on this server");
  assert.equal(seen?.companion.settings.voice, null, "the model is not told to speak when it cannot");
  assert.deepEqual(await run(watcher, turn("gone"), speaker), text("嗯"), "a voice no longer in the catalog");
  assert.equal(seen?.companion.settings.voice, null);
  assert.deepEqual(await run(devChatModel, turn("warm"), devSpeaker), ["SENT", ["（开发环境假回复）我是小光", "收到：「我回来了」"],
    [await devSpeaker.speak("（开发环境假回复）我是小光", file.voices[0]!, null, new AbortController().signal), null]]);
});

const session = (port: ChatPort): AuthenticatedOwnerSession =>
  ({ ownerId: "00000000-0000-0000-0000-0000000001a1", owner: {} as OwnerApiPort, chat: port });
const get = (path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): MvpHttpRequest =>
  ({ method, url: `/v0/${path}`, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body }) });

it("lists voices, plays samples and serves voice messages with ranges", async () => {
  const saved: unknown[] = [];
  const port = {
    audio: async (chat: string, message: string) => {
      if (message !== messageId || chat !== chatId) throw new Error("not this one");
      return { mime: "audio/mpeg", bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) };
    },
    settings: async () => ({ voice: "warm" }),
    saveSettings: async (_id: string, value: unknown) => { saved.push(value); return value; },
  } as unknown as ChatPort;
  let failSample = false;
  const voices = new Voices(catalog, { speak: async text => { if (failSample) throw new Error("down"); return clip(text); } });
  const replies = new ChatReplies(undefined, undefined, voices);
  const call = (req: MvpHttpRequest, using = replies) => handleChatRequest(req, session(port), "trace", using);

  assert.deepEqual((await call(get("voices")))!.body, { available: true, items: [
    { id: "warm", name: "暖暖", gender: "FEMALE", description: "温暖" }, { id: "calm-boy", name: "阿静", gender: "MALE", description: "安静" },
  ] });
  assert.deepEqual((await call(get("voices"), new ChatReplies()))!.body, { available: false, items: [] });
  const sample = (await call(get("voices/warm/sample")))!;
  assert.equal(sample.status, 200);
  assert.equal(sample.headers["content-type"], "audio/mpeg");
  assert.equal(new TextDecoder().decode(sample.body as Uint8Array), "你好呀");
  await assert.rejects(call(get("voices/ghost/sample")), { code: "NOT_FOUND" });
  await assert.rejects(call(get("voices/warm/sample"), new ChatReplies(undefined, undefined, new Voices(catalog))), { code: "NOT_FOUND" });
  await assert.rejects(call(get("voices", {}, "POST")), { code: "NOT_FOUND" });
  failSample = true;
  await assert.rejects(call(get("voices/calm-boy/sample")), { code: "DATABASE_UNAVAILABLE" });

  const path = `chats/${chatId}/messages/${messageId}/audio`;
  const whole = (await call(get(path)))!;
  assert.deepEqual([whole.status, whole.headers["content-length"], whole.headers["accept-ranges"]], [200, "10", "bytes"]);
  const ranges: [string, number, string | undefined, number[]][] = [
    ["bytes=2-4", 206, "bytes 2-4/10", [2, 3, 4]],
    ["bytes=8-", 206, "bytes 8-9/10", [8, 9]],
    ["bytes=-3", 206, "bytes 7-9/10", [7, 8, 9]],
    ["bytes=5-99", 206, "bytes 5-9/10", [5, 6, 7, 8, 9]],
    ["bytes=-", 200, undefined, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ["items=1-2", 200, undefined, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ["bytes=12-", 416, "bytes */10", []],
    ["bytes=4-2", 416, "bytes */10", []],
  ];
  for (const [range, status, contentRange, bytes] of ranges) {
    const answer = (await call(get(path, { Range: range })))!;
    assert.equal(answer.status, status, range);
    assert.equal(answer.headers["content-range"], contentRange, range);
    assert.deepEqual([...(answer.body as Uint8Array)], bytes, range);
  }
  await assert.rejects(call(get(`chats/${chatId}/messages/not-an-id/audio`)), { code: "INVALID_INPUT" });
  await assert.rejects(call(get(path, {}, "POST")), { code: "NOT_FOUND" });

  const put = { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, revision: 3 };
  const settingsPath = `companions/${companion}/chat-settings`;
  await call(get(settingsPath, {}, "PUT", { ...put, voice: "calm-boy" }));
  await call(get(settingsPath, {}, "PUT", { ...put, voice: null }));
  await call(get(settingsPath, {}, "PUT", put));
  assert.deepEqual(saved, [{ ...put, voice: "calm-boy" }, { ...put, voice: null }, { ...put, voice: "warm" }]);
  await assert.rejects(call(get(settingsPath, {}, "PUT", { ...put, voice: "ghost" })), { code: "INVALID_INPUT" });
  await assert.rejects(call(get(settingsPath, {}, "PUT", { ...put, voice: "warm" }), new ChatReplies()), { code: "INVALID_INPUT" });
});

it("stores clips with the reply and reads audio back through the database", async () => {
  const seen: [string, readonly unknown[]][] = [];
  let rows: Record<string, unknown>[] = [{ payload: { accepted: true } }];
  const executor: SqlExecutor = { query: async (sql, values) => { seen.push([sql, values]); return { rows } as never; } };
  const adapter = new PostgresChatAdapter(executor);
  assert.equal(await adapter.finish(messageId, "c", "SENT", ["嗯", "好"], [clip("嗯"), null]), true);
  assert.deepEqual(JSON.parse(seen.at(-1)![1][4] as string),
    [{ mime: "audio/mpeg", durationMs: 1000, characters: 2, data: Buffer.from("嗯").toString("base64") }, null]);
  await adapter.finish(messageId, "c", "SENT", ["嗯"], [null]);
  assert.equal(seen.at(-1)![1][4], null, "all text: no audio sent");
  await adapter.finish(messageId, "c", "ERROR", null);
  assert.equal(seen.at(-1)![1][4], null);
  rows = [{ payload: { left: 7 } }];
  assert.equal(await adapter.voiceLeft(), 7);
  rows = [{ payload: {} }];
  assert.equal(await adapter.voiceLeft(), 0);
  rows = [{ payload: { mime: "audio/wav", durationMs: 5, data: Buffer.from([1, 2]).toString("base64") } }];
  assert.deepEqual(await adapter.audio(chatId, messageId), { mime: "audio/wav", bytes: Buffer.from([1, 2]) });
  assert.deepEqual(seen.at(-1)![1], [chatId, messageId]);
  rows = [{ payload: { mime: "audio/wav" } }];
  await assert.rejects(adapter.audio(chatId, messageId), { code: "DATABASE_ERROR" });
});
