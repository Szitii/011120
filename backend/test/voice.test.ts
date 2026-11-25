import assert from "node:assert/strict";
import { it } from "node:test";
import { handleChatRequest } from "../src/chat/http.ts";
import { PostgresChatAdapter } from "../src/chat/postgres.ts";
import { agentMessages, replyPrompt, splitVoice } from "../src/chat/prompt.ts";
import { ChatReplies, devChatModel, type ChatModel, type ReplyTrace } from "../src/chat/replies.ts";
import {
  devSpeaker, MiniMaxSpeaker, MiniMaxTranscriber, SpeechError, VoiceCatalog, Voices, type Clip, type Emotion, type Speaker, type VoiceFile,
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
  const used: [string, number][] = [];
  const port = {
    voiceUsed: async (kind: string, amount: number) => { if (left === -2) throw new Error("db down"); used.push([kind, amount]); },
    claim: async () => { const next = claimed ? null : claim; claimed = true; return next; },
    finish: async (_reply: string, _claim: string, outcome: ChatOutcome, bodies: string[] | null, clips?: (Clip | null)[]) => {
      finished.push([outcome, bodies, clips]); return true;
    },
    voiceLeft: async () => { if (left < 0) throw new Error("db down"); return { companion: left, owner: 0 }; },
    memories: async () => ({ items: [] }),
  } as unknown as ChatPort;
  let claimed = false;
  return { port, finished, used };
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
  // Each failure has a code for the log, without the provider's own words.
  const failures: [number, unknown, RegExp, string][] = [
    [500, {}, /HTTP 500/, "HTTP_500"],
    [200, { base_resp: { status_code: 1008, status_msg: "insufficient balance" } }, /1008 insufficient balance/, "REFUSED_1008"],
    [200, {}, /refused: undefined/, "REFUSED"],
    [200, { base_resp: { status_code: 0 }, data: { audio: "xyz" }, extra_info: { audio_length: 1 } }, /unexpected shape/, "BAD_ANSWER"],
    [200, { base_resp: { status_code: 0 }, data: { audio: "fff" }, extra_info: { audio_length: 1 } }, /unexpected shape/, "BAD_ANSWER"],
    [200, { base_resp: { status_code: 0 }, data: { audio: "ff" }, extra_info: { audio_length: 0 } }, /unexpected shape/, "BAD_ANSWER"],
    [200, { base_resp: { status_code: 0 }, data: {}, extra_info: {} }, /unexpected shape/, "BAD_ANSWER"],
  ];
  for (const [status, payload, message, code] of failures) {
    await assert.rejects(new MiniMaxSpeaker(file.provider, "k", answer(status, payload)).speak("a", file.voices[0]!, null, signal),
      (error: unknown) => error instanceof SpeechError && error.code === code && message.test(error.message));
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
  const traces: ReplyTrace[] = [];
  const replies = new ChatReplies(says("[语音:开心]你回来啦", "今天做了什么？", "[语音]抱抱"), undefined, new Voices(catalog, speaker),
    undefined, trace => traces.push(trace));
  const { port, finished, used } = replyPort(turn("warm"));
  assert.equal(await replies.drain(chatId, port), 1);
  const [{ modelMs, speechMs, ...traced }] = traces as [ReplyTrace];
  assert.deepEqual(traced, { event: "chat_reply", chatId, replyId: messageId, companionId: companion, channel: "PLATFORM",
    outcome: "SENT", voice: ["SPOKEN", "NO_MARK", "SPOKEN"], stored: true }, "one line per turn, without what was said");
  assert.ok(modelMs >= 0 && speechMs >= 0);
  assert.deepEqual(said, [["你回来啦", "warm", "happy"], ["抱抱", "warm", null]]);
  assert.deepEqual(used, [["SPEAK", 2], ["SPEAK", 2]], "each clip is booked with the characters billed");
  assert.deepEqual(finished, [["SENT", ["你回来啦", "今天做了什么？", "抱抱"], [clip("你回来啦"), null, clip("抱抱")]]]);
  assert.equal(replies.voices?.available, true);
});

it("falls back to text when a voice message cannot be made", async () => {
  const run = async (model: ChatModel, claim: ChatClaim, speaker: Speaker | undefined, left = 60, timeoutMs?: number) => {
    const { port, finished } = replyPort(claim, left);
    const voices = speaker === undefined ? undefined : new Voices(catalog, speaker);
    await new ChatReplies(model, undefined, voices, timeoutMs, trace => { why = trace.voice; }).drain(chatId, port);
    return finished[0]!;
  };
  // Why each message of the last reply was or was not a voice message, as the trace says it.
  let why: ReplyTrace["voice"] = [];
  const text = (...bodies: string[]) => ["SENT", bodies, undefined];
  const { speaker, said } = recordingSpeaker(t => t === "坏");
  assert.deepEqual(await run(says("[语音]好", "[语音]坏"), turn("warm"), speaker), ["SENT", ["好", "坏"], [clip("好"), null]],
    "a failed clip is text");
  assert.deepEqual(why, ["SPOKEN", "SPEECH_FAILED"]);
  assert.deepEqual(await run(says("[语音]坏"), turn("warm"), speaker), text("坏"), "all failed: plain text");
  assert.deepEqual(await run(says("[语音]一", "[语音]二"), turn("warm"), speaker, 1), ["SENT", ["一", "二"], [clip("一"), null]],
    "only as many as today's voice messages left");
  assert.deepEqual(why, ["SPOKEN", "OVER_LIMIT"]);
  assert.deepEqual(await run(says("[语音]一"), turn("warm"), speaker, -1), text("一"), "the count could not be read");
  assert.deepEqual(why, ["LIMIT_UNKNOWN"]);
  const unbooked = replyPort(turn("warm"), -2);
  (unbooked.port as unknown as { voiceLeft: () => Promise<unknown> }).voiceLeft = async () => ({ companion: 5, owner: 0 });
  await new ChatReplies(says("[语音]好"), undefined, new Voices(catalog, speaker)).drain(chatId, unbooked.port);
  assert.deepEqual(unbooked.finished[0], ["SENT", ["好"], [clip("好")]], "a booking that fails does not cost the message");
  assert.deepEqual(await run(says(`[语音]${"长".repeat(121)}`), turn("warm"), speaker), text("长".repeat(121)), "too long to say");
  assert.deepEqual(why, ["TOO_LONG"]);
  assert.deepEqual(await run(says("[语音]一", "二", "[语音]三", "[语音]四"), turn("warm"), speaker),
    ["SENT", ["一", "二", "三\n四"], [clip("一"), null, null]], "joined messages are text");
  assert.deepEqual(why, ["SPOKEN", "NO_MARK", "MERGED"]);
  assert.deepEqual(await run(says("[语音:开心]你好"), turn(null), speaker), text("你好"), "no voice chosen: the mark is dropped");
  assert.deepEqual(why, ["NO_VOICE"]);
  assert.deepEqual(await run(says("[语音]", "嗯"), turn("warm"), speaker), text("嗯"), "a mark alone is nothing");
  assert.deepEqual(await run(says("[语音]手机 13800138000", "[语音]记一下"), turn("warm"), speaker),
    ["SENT", ["手机 [REDACTED_PII]", "记一下"], [null, clip("记一下")]], "what the safety scan changed is text");
  assert.deepEqual(why, ["REDACTED", "SPOKEN"]);
  const hanging: Speaker = { speak: (_t, _v, _e, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) };
  assert.deepEqual(await run(says("[语音]嗯"), turn("warm"), hanging, 60, 5), text("嗯"), "too slow: text");
  assert.deepEqual(why, ["SPEECH_TIMEOUT"]);
  const refusing: Speaker = { speak: async () => { throw new SpeechError("REFUSED_1008", "insufficient balance"); } };
  assert.deepEqual(await run(says("[语音]嗯"), turn("warm"), refusing), text("嗯"));
  assert.deepEqual(why, ["SPEECH_FAILED_REFUSED_1008"], "the provider's status, not its words");
  assert.equal(said.filter(([t]) => t === "二").length, 0);

  let seen: ChatClaim | undefined;
  const watcher: ChatModel = { reply: async claim => { seen = claim; return { messages: ["[语音]嗯"] }; } };
  assert.deepEqual(await run(watcher, turn("warm"), undefined), text("嗯"), "no voices on this server");
  assert.deepEqual(why, ["VOICE_UNAVAILABLE"]);
  assert.equal(seen?.companion.settings.voice, null, "the model is not told to speak when it cannot");
  assert.deepEqual(await run(watcher, turn("gone"), speaker), text("嗯"), "a voice no longer in the catalog");
  assert.equal(seen?.companion.settings.voice, null);
  assert.deepEqual(await run(devChatModel, turn("warm"), devSpeaker), ["SENT", ["（开发环境假回复）我是小光", "收到：「我回来了」"],
    [await devSpeaker.speak("（开发环境假回复）我是小光", file.voices[0]!, null, new AbortController().signal), null]]);

  // A reply that was not saved, or not written at all, leaves its line too.
  const traces: ReplyTrace[] = [];
  const lost = async (finish: () => Promise<boolean>, model?: ChatModel) => {
    const { port } = replyPort(turn("warm"));
    (port as unknown as { finish: () => Promise<boolean> }).finish = finish;
    await new ChatReplies(model, undefined, new Voices(catalog, speaker), undefined, trace => traces.push(trace)).drain(chatId, port).catch(() => undefined);
    const { outcome, voice, stored } = traces.at(-1)!;
    return [outcome, voice, stored];
  };
  assert.deepEqual(await lost(async () => false, says("[语音]好")), ["SENT", ["SPOKEN"], false], "spoken, but the turn had moved on");
  assert.deepEqual(await lost(async () => { throw new Error("db down"); }, says("[语音]好")), ["SENT", ["SPOKEN"], false], "spoken, but not saved");
  assert.deepEqual(await lost(async () => true), ["UNAVAILABLE", [], true], "no model: nothing to say");
  assert.equal(traces.length, 3);
});

const session = (port: ChatPort): AuthenticatedOwnerSession =>
  ({ ownerId: "00000000-0000-0000-0000-0000000001a1", owner: {} as OwnerApiPort, chat: port });
const get = (path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): MvpHttpRequest =>
  ({ method, url: `/v0/${path}`, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body }) });

it("lists voices, plays samples and serves voice messages with ranges", async () => {
  const saved: unknown[] = [], booked: unknown[][] = [];
  const port = {
    audio: async (chat: string, message: string) => {
      if (message !== messageId || chat !== chatId) throw new Error("not this one");
      return { mime: "audio/mpeg", bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) };
    },
    settings: async () => ({ voice: "warm" }),
    saveSettings: async (_id: string, value: unknown) => { saved.push(value); return value; },
    voiceUsed: async (...args: unknown[]) => { booked.push(args); },
  } as unknown as ChatPort;
  let failSample = false;
  const voices = new Voices(catalog, { speak: async text => { if (failSample) throw new Error("down"); return clip(text); } });
  const replies = new ChatReplies(undefined, undefined, voices);
  const call = (req: MvpHttpRequest, using = replies) => handleChatRequest(req, session(port), "trace", using);

  assert.deepEqual((await call(get("voices")))!.body, { available: true, input: false, items: [
    { id: "warm", name: "暖暖", gender: "FEMALE", description: "温暖" }, { id: "calm-boy", name: "阿静", gender: "MALE", description: "安静" },
  ] });
  assert.deepEqual((await call(get("voices"), new ChatReplies()))!.body, { available: false, input: false, items: [] });
  const sample = (await call(get("voices/warm/sample")))!;
  assert.equal(sample.status, 200);
  assert.equal(sample.headers["content-type"], "audio/mpeg");
  assert.equal(new TextDecoder().decode(sample.body as Uint8Array), "你好呀");
  await call(get("voices/warm/sample"));
  assert.deepEqual(booked, [["SPEAK", 2]], "a sample made is paid for and booked once; a kept one is free");
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
  rows = [{ payload: { left: 7, ownerLeft: 3 } }];
  assert.deepEqual(await adapter.voiceLeft(), { companion: 7, owner: 3 });
  rows = [{ payload: null }];
  await adapter.voiceUsed("HEAR", 2300.4);
  await adapter.voiceUsed("SPEAK", -3);
  assert.deepEqual(seen.slice(-2).map(([, values]) => values), [["HEAR", 2300], ["SPEAK", 0]], "the function returns nothing, and that is fine");
  rows = [{ payload: {} }];
  assert.deepEqual(await adapter.voiceLeft(), { companion: 0, owner: 0 });
  rows = [{ payload: { message: { id: "m" } } }];
  await adapter.sendVoice(chatId, "你好", { mime: "audio/mp4", durationMs: 1500, bytes: new Uint8Array([7, 8]) }, "k");
  assert.equal(seen.at(-1)![0], "select public.chat_send_voice($1,$2,$3,$4::jsonb) as payload");
  assert.deepEqual(seen.at(-1)![1].slice(0, 3), [chatId, "你好", "k"]);
  assert.deepEqual(JSON.parse(seen.at(-1)![1][3] as string), { mime: "audio/mp4", durationMs: 1500, data: Buffer.from([7, 8]).toString("base64") });
  rows = [{ payload: { mime: "audio/wav", durationMs: 5, data: Buffer.from([1, 2]).toString("base64") } }];
  assert.deepEqual(await adapter.audio(chatId, messageId), { mime: "audio/wav", bytes: Buffer.from([1, 2]) });
  assert.deepEqual(seen.at(-1)![1], [chatId, messageId]);
  rows = [{ payload: { mime: "audio/wav" } }];
  await assert.rejects(adapter.audio(chatId, messageId), { code: "DATABASE_ERROR" });
});

it("hears the Owner's recordings through MiniMax", async () => {
  const sent: [string, RequestInit][] = [];
  const answer = (status: number, payload: unknown) => (async (url: string, init: RequestInit) => {
    sent.push([url, init]);
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  const signal = new AbortController().signal;
  const heard = await new MiniMaxTranscriber(file.provider, "secret", answer(200, { text: "我回来了", duration: 1.25 }))
    .transcribe(new Uint8Array([1, 2, 3]), "audio/mp4", signal);
  assert.deepEqual(heard, { text: "我回来了", durationMs: 1250 });
  const [url, init] = sent[0]!;
  assert.equal(url, "https://speech.example/v1/speech_to_text");
  assert.equal((init.headers as Record<string, string>).authorization, "Bearer secret");
  const form = init.body as FormData;
  assert.deepEqual([form.get("model"), form.get("response_format")], ["asr-1.0", "json"]);
  const upload = form.get("file") as File;
  assert.deepEqual([upload.name, upload.type, upload.size], ["voice.m4a", "audio/mp4", 3]);
  assert.equal(init.signal, signal);
  assert.deepEqual(await new MiniMaxTranscriber(file.provider, "k", answer(200, { text: "" })).transcribe(new Uint8Array([1]), "audio/aac", signal),
    { text: "", durationMs: 0 });
  await assert.rejects(new MiniMaxTranscriber(file.provider, "k", answer(402, { type: "error" })).transcribe(new Uint8Array([1]), "audio/wav", signal), /HTTP 402/);
  await assert.rejects(new MiniMaxTranscriber(file.provider, "k", answer(200, { words: [] })).transcribe(new Uint8Array([1]), "audio/ogg", signal), /unexpected shape/);

  assert.equal(Voices.fromEnvironment("supabase-auth", {}).listening, false);
  assert.equal(Voices.fromEnvironment("supabase-auth", { MINIMAX_API_KEY: "k" }).listening, true);
  const dev = Voices.fromEnvironment("stage1-mobile-dev", {});
  assert.match((await dev.transcribe(new Uint8Array([1]), "audio/mp4", signal)).text, /开发环境假转写/);
  await assert.rejects(new Voices(catalog).transcribe(new Uint8Array([1]), "audio/mp4", signal), /no speech recognition/);
});

it("marks voice messages in what the model reads", () => {
  const spoken = { ...turn("warm"), history: [
    { companionId: null, body: "我回来了", action: null, mentions: [], sentAt: "t1", voice: true },
    { companionId: companion, body: "欢迎回来", action: null, mentions: [], sentAt: "t2", voice: false },
  ] };
  assert.match(replyPrompt(spoken).user, /【主人】（语音）我回来了\n【小光】欢迎回来/);
  assert.deepEqual(agentMessages(spoken).slice(1, 3).map(m => m.content), ["（语音）我回来了", "欢迎回来"]);
});

it("takes the Owner's voice message: recognise, store, then reply", async () => {
  const calls: unknown[][] = [];
  const used: unknown[][] = [];
  let ownerLeft = 5;
  const port = {
    voiceLeft: async () => ({ companion: 0, owner: ownerLeft }),
    voiceUsed: async (...args: unknown[]) => { used.push(args); if (used.length === 3) throw new Error("db down"); },
    sendVoice: async (...args: unknown[]) => { calls.push(args); return { message: { id: "m" }, typing: [], replying: true }; },
  } as unknown as ChatPort;
  let heard: string | Error = "  我 回来\n了 ", length = 9;
  const transcriber = { transcribe: async () => { if (heard instanceof Error) throw heard; return { text: heard, durationMs: length }; } };
  const kicked: string[] = [];
  const replies = new ChatReplies(undefined, undefined, new Voices(catalog, undefined, transcriber));
  (replies as unknown as { kick: (id: string) => void }).kick = id => { kicked.push(id); };
  const recording = Buffer.from("m4a-bytes").toString("base64");
  const post = (input: unknown, using = replies, headers: Record<string, string> = { "idempotency-key": "voice-key-0000000001" }) =>
    handleChatRequest(get(`chats/${chatId}/voice`, headers, "POST", input), session(port), "trace", using);
  const ok = { audio: recording, mime: "audio/mp4", durationMs: 2300 };

  const sent = (await post(ok))!;
  assert.equal(sent.status, 201);
  assert.deepEqual(kicked, [chatId], "replies start");
  const [chat, words, said, key] = calls[0] as [string, string, { mime: string; durationMs: number; bytes: Uint8Array }, string];
  assert.deepEqual([chat, words, said.mime, said.durationMs, Buffer.from(said.bytes).toString()], [chatId, "我 回来 了", "audio/mp4", 2300, "m4a-bytes"]);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal((await post(ok, replies, {}).catch((error: { code: string }) => error.code)), "INVALID_INPUT", "needs an Idempotency-Key");

  for (const bad of [{ ...ok, audio: "" }, { ...ok, audio: "a=b" }, { ...ok, mime: "audio/webm" }, { ...ok, mime: "toString" },
    { ...ok, durationMs: 0 }, { ...ok, durationMs: 60_001 }, { ...ok, durationMs: 1.5 }, { ...ok, extra: 1 },
    { ...ok, audio: Buffer.alloc(700 * 1024 + 1).toString("base64") }]) {
    await assert.rejects(post(bad), { code: "INVALID_INPUT" }, JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual((await post(ok, new ChatReplies()))!.body, { code: "VOICE_UNAVAILABLE" });
  assert.deepEqual((await post(ok, new ChatReplies(undefined, undefined, new Voices(catalog))))!.body, { code: "VOICE_UNAVAILABLE" });
  assert.deepEqual(used, [["HEAR", 9]], "recognition is booked by length");
  length = 0;
  await post(ok);
  await post(ok);
  assert.deepEqual(used.slice(1), [["HEAR", 2300], ["HEAR", 2300]], "without a length from the provider, the recording's");
  assert.equal(calls.length, 3, "a booking that fails does not lose the message");
  calls.length = 1; used.length = 0;
  heard = new Error("402");
  assert.deepEqual([(await post(ok))!.status, (await post(ok))!.body], [503, { code: "VOICE_UNAVAILABLE" }]);
  heard = " \n ";
  assert.deepEqual([(await post(ok))!.status, (await post(ok))!.body], [422, { code: "VOICE_NOT_UNDERSTOOD" }]);
  assert.deepEqual(used, [["HEAR", 2300], ["HEAR", 2300]], "a failed call is not booked; one not understood is (it was billed)");
  heard = "长".repeat(2100);
  await post(ok);
  assert.equal(Array.from((calls.at(-1) as string[])[1]!).length, 2000, "cut to what a message holds");
  ownerLeft = 0;
  assert.deepEqual([(await post(ok))!.status, (await post(ok))!.body], [429, { code: "VOICE_LIMIT" }]);
  assert.equal(calls.length, 2, "nothing stored without a recognised message");
});
