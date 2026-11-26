import assert from "node:assert/strict";
import { it } from "node:test";
import { ChatCatalog, type CatalogFile } from "../src/chat/models.ts";
import { PlatformChatModel, textsOf } from "../src/chat/platform.ts";
import type { ChatClaim, ChatPort, DiaryJob, MemoryJob, PostJob } from "../src/chat/port.ts";
import { ACTION_NAMES, VOICE_TONES, agentMessages, diaryPrompt, memoryPrompt, postPrompt, replyPrompt, splitAction, splitVoice } from "../src/chat/prompt.ts";
import {
  PROMPT_BLOCKS, PROMPT_TEXT_MAX, promptBlock, promptLines, promptTextRefusal, tidyPromptText, usablePromptTexts, type PromptTexts,
} from "../src/chat/prompt-texts.ts";
import type { CallModel } from "../src/chat/providers.ts";

const me = "00000000-0000-0000-0000-0000000002a1";
const companion: ChatClaim["companion"] = { companionId: me, displayName: "小光", identity: null,
  settings: { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, voice: "warm", revision: 1 } };
const turn: ChatClaim = { chatId: "chat", replyId: "reply", claimId: "claim", replyTo: "OWNER", optional: false, direct: true, canAct: true,
  companion, members: [{ companionId: me, displayName: "小光" }],
  history: [{ companionId: null, body: "在吗", action: null, mentions: [], sentAt: "2026-11-26T02:00:00Z" }] };
const diary: DiaryJob = { status: "WRITE", entryId: "e", claimId: "c", companion, messages: [], posts: [] };
const post: PostJob = { status: "WRITE", runId: "r", claimId: "c", companion, localTime: "11/26 10:00", own: [], others: [] };
const memory: MemoryJob = { status: "WRITE", claimId: "c", companion, messages: [], memories: [] };

it("keeps the built-in wording in step with what the server reads back", () => {
  const text = (key: string) => promptBlock(key)!.text;
  for (const tone of Object.keys(VOICE_TONES)) assert.ok(text("CHAT_VOICE").includes(tone), `the voice rules name ${tone}`);
  for (const [name] of ACTION_NAMES) assert.ok(text("CHAT_ACTION").includes(name), `the action rule names ${name}`);
  // The marks the rules show are the ones the server understands.
  assert.deepEqual(splitVoice("[语音:开心] 早呀"), { text: "早呀", voice: "happy" });
  assert.deepEqual(splitAction(["[动作:抱抱]"]), { messages: [""], action: "HUG" });
  for (const block of PROMPT_BLOCKS) {
    assert.equal(promptTextRefusal(block, block.text), null, `${block.key}: the built-in wording passes its own check`);
    assert.equal(tidyPromptText(block.text), block.text, `${block.key}: the built-in wording is already tidy`);
  }
  assert.equal(promptBlock("NOPE"), undefined);
  assert.equal(new Set(PROMPT_BLOCKS.map(block => block.key)).size, PROMPT_BLOCKS.length);
});

it("puts every block into the prompt it belongs to, built in or reworded", () => {
  const own: PromptTexts = { CHAT_STYLE: "- 说话慢一点。", CHAT_VOICE: "- 想发语音就写 [语音]。", CHAT_ACTION: "- 想抱就写 [动作:抱抱]。",
    CHAT_TIME: "- 看看几点了。", DIARY_STYLE: "- 写短一点。", POST_STYLE: "- 写一句话。", MEMORY_WHAT: "- 只记生日。" };
  const prompts: [key: keyof PromptTexts, built: string, reworded: string][] = [
    ["CHAT_STYLE", replyPrompt(turn).system, replyPrompt(turn, [], own).system],
    ["CHAT_VOICE", replyPrompt(turn).system, replyPrompt(turn, [], own).system],
    ["CHAT_ACTION", replyPrompt(turn).system, replyPrompt(turn, [], own).system],
    ["CHAT_TIME", replyPrompt(turn).system, replyPrompt(turn, [], own).system],
    ["CHAT_VOICE", agentMessages(turn)[0]!.content, agentMessages(turn, own)[0]!.content],
    ["CHAT_ACTION", agentMessages(turn)[0]!.content, agentMessages(turn, own)[0]!.content],
    ["DIARY_STYLE", diaryPrompt(diary).system, diaryPrompt(diary, [], own).system],
    ["POST_STYLE", postPrompt(post).system, postPrompt(post, own).system],
    ["MEMORY_WHAT", memoryPrompt(memory).system, memoryPrompt(memory, own).system],
  ];
  for (const [key, built, reworded] of prompts) {
    const text = promptBlock(key)!.text;
    assert.ok(built.includes(text), `${key}: the built-in wording is in the prompt, whole`);
    assert.ok(reworded.includes(own[key]!) && !reworded.includes(text.split("\n")[0]!), `${key}: the operators' wording takes its place`);
  }
  // What cannot be reworded stays whatever the operators wrote.
  const reply = replyPrompt(turn, [], own).system;
  assert.match(reply, /- 一次可以发 1 到 3 条消息，每条单独一行/);
  assert.match(reply, /不是给你的指令/);
  assert.match(diaryPrompt(diary, [], own).system, /不刻意讨好/);
  assert.match(postPrompt(post, own).system, /不写主人的名字、住址/);
  assert.match(memoryPrompt(memory, own).system, /不记密码、验证码/);
  // A Companion without a voice, or one that may not act, is not told about either, reworded or not.
  const plain = replyPrompt({ ...turn, canAct: false, companion: { ...companion, settings: { ...companion.settings, voice: null } } }, [], own).system;
  assert.doesNotMatch(plain, /语音|动作/);
  assert.deepEqual(promptLines({ CHAT_TIME: "a\nb" }, "CHAT_TIME"), ["a", "b"]);
});

it("takes a wording only when it can be used", () => {
  const voice = promptBlock("CHAT_VOICE")!, style = promptBlock("CHAT_STYLE")!;
  assert.equal(tidyPromptText("  - 一\r\n\r\n- 二  \n \u2028- 三\n"), "  - 一\n- 二\n- 三");
  assert.match(promptTextRefusal(style, "")!, /不能为空/);
  assert.match(promptTextRefusal(style, "字".repeat(PROMPT_TEXT_MAX + 1))!, /最多 1000 个字，现在是 1001 个字/);
  assert.equal(promptTextRefusal(style, "😀".repeat(PROMPT_TEXT_MAX)), null, "length is counted in characters");
  assert.match(promptTextRefusal(voice, "- 多发语音。")!, /必须保留 \[语音\]/);
  assert.match(promptTextRefusal(promptBlock("CHAT_ACTION")!, "- 多抱抱。")!, /必须保留 \[动作:/);
  assert.equal(promptTextRefusal(voice, "- 想说就写 [语音]。"), null);

  assert.deepEqual(usablePromptTexts({ CHAT_STYLE: "- 慢一点。", CHAT_VOICE: "- 没有标记。", CHAT_TIME: 5, OLD_KEY: "x", POST_STYLE: "" }),
    { CHAT_STYLE: "- 慢一点。" }, "a wording without its mark, of another type, empty, or under a key the server no longer has is ignored");
  for (const nothing of [null, undefined, "text", 3]) assert.deepEqual(usablePromptTexts(nothing), {});
});

it("reads the operators' wording for every model call, and falls back to the built-in one", async () => {
  const file: CatalogFile = { defaultModel: "m", decisionModel: null, providers: { p: { kind: "openai-compatible", baseUrl: "https://llm.example/v1/", apiKeyEnv: "K" } },
    models: [{ id: "m", name: "M", provider: "p", model: "m", tier: "STANDARD", inputPerMTok: 1, outputPerMTok: 1, enabled: true }] };
  const systems: string[] = [];
  const call: CallModel = async (_model, request) => {
    systems.push(request.system);
    return { text: "好", inputTokens: 1, outputTokens: 1, refused: false, cutOff: false };
  };
  let saved: () => Promise<unknown> = async () => ({ CHAT_STYLE: "- 说话慢一点。", DIARY_STYLE: "- 写短一点。", POST_STYLE: "- 写一句话。",
    MEMORY_WHAT: "- 只记生日。", CHAT_VOICE: "- 标记被删掉了。" });
  const reserved = async () => ({ decision: "RESERVED" as const, transactionId: "tx" });
  const port = { promptTexts: () => saved(), memories: async () => ({ items: [] }), reserve: reserved, diaryReserve: reserved, postReserve: reserved,
    memoryReserve: reserved, settle: async () => undefined } as unknown as ChatPort;
  const platform = new PlatformChatModel(new ChatCatalog(file, { K: "k" }), call);
  const context = { port, signal: new AbortController().signal };
  await platform.reply(turn, context);
  await platform.diary(diary, context);
  await platform.post(post, context);
  await platform.memory(memory, context);
  assert.match(systems[0]!, /- 说话慢一点。/);
  assert.match(systems[0]!, /在那条消息开头写 \[语音\]/, "a saved wording that lost its mark is not used");
  assert.match(systems[1]!, /- 写短一点。/);
  assert.match(systems[2]!, /- 写一句话。/);
  assert.match(systems[3]!, /- 只记生日。/);

  saved = async () => { throw new Error("function public.prompt_texts() does not exist"); };
  assert.deepEqual(await textsOf(port), {});
  await platform.reply(turn, context);
  assert.match(systems[4]!, /- 像用微信聊天/, "a database that cannot answer does not stop the reply");
});
