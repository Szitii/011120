/**
 * Writes Companion replies in the background, one at a time per chat.
 *
 * The database decides who answers and queues those turns, and decides when each message is
 * shown ("typing…" first, longer for longer messages). This file takes the turns one by one
 * (chat_claim), asks the model, runs the output safety scan, says the messages the model marked
 * as voice messages aloud (when the Companion has a voice) and stores the result (chat_finish).
 * If the server stops halfway, the claim expires after two minutes and the next request that
 * touches the chat picks it up again.
 */
import { ACTION_TEXT, answersAction, splitVoice } from "./prompt.ts";
import { SafetyPipeline } from "./safety.ts";
import type { DiaryWriteResult } from "../../../contracts/chat.ts";
import type { ChatClaim, ChatOutcome, ChatPort, DiaryJob, PostJob, PostOutcome, PostStart } from "./port.ts";
import type { Clip, Emotion, Voices } from "./voices.ts";

/**
 * What a model made of a turn: 1 to 3 short messages, like texting (more are joined into the
 * third); `pass` to stay quiet (only allowed when the turn is optional); `refused` when the
 * provider declined for safety reasons; or `failed` when no call could be made.
 */
export type Answer =
  | { messages: string[] }
  | { pass: true }
  | { refused: true }
  | { failed: "UNAVAILABLE" | "DISABLED" | "QUOTA" };

/** A diary entry the model wrote, or why there is none. */
export type DiaryAnswer = { text: string } | { refused: true } | { failed: "UNAVAILABLE" | "DISABLED" | "QUOTA" };

/** A community post the model wrote on its own; `pass` when it had nothing to say. */
export type PostAnswer = DiaryAnswer | { pass: true };

/** Something that can speak as a Companion. `signal` aborts when it takes too long: pass it on. */
export interface ChatModel {
  reply(turn: ChatClaim, context: { port: ChatPort; signal: AbortSignal }): Promise<Answer>;
  /** Writes a diary entry; without it, diary entries fail as UNAVAILABLE. */
  diary?(job: DiaryJob, context: { port: ChatPort; signal: AbortSignal }): Promise<DiaryAnswer>;
  /** Writes a community post of its own; without it, such posts fail. */
  post?(job: PostJob, context: { port: ChatPort; signal: AbortSignal }): Promise<PostAnswer>;
}

const MAX_MESSAGES = 3;
// Under the database's 2-minute claim, so a hung model call ends here before another server could take the turn.
const MODEL_TIMEOUT_MS = 90_000;
// Model and speech together stay under the 2-minute claim.
const SPEECH_TIMEOUT_MS = 25_000;
/** Longer messages are sent as text: nobody records a minute-long voice message to say it. */
const MAX_VOICE_CHARS = 120;
const MAX_CHARS = 2000;
/** A post of its own is short; the prompt asks for 20 to 200 characters. */
const MAX_POST_CHARS = 1000;
const PREVIEW = 40;
const preview = (text: string): string => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= PREVIEW ? chars.join("") : `${chars.slice(0, PREVIEW).join("")}……`;
};

/**
 * Development only: fixed replies, so the app can be built before a real model is connected.
 * An optional answer to the Owner (group activity NORMAL) uses a crude stand-in for "does this
 * concern me": it answers when the message says its name, 大家 or 你们, and stays quiet otherwise.
 */
export const devChatModel: ChatModel = {
  async reply(turn) {
    const name = turn.companion.displayName;
    if (answersAction(turn)) {
      const action = [...turn.history].reverse().find(message => message.action !== null)?.action;
      return { messages: [`（开发环境假回复）${name}知道你${action ? ACTION_TEXT[action] : "来过"}`] };
    }
    if (turn.replyTo === "OWNER") {
      const said = [...turn.history].reverse().find(message => message.companionId === null)?.body ?? "";
      if (turn.optional && ![name, "大家", "你们"].some(word => said.includes(word))) return { pass: true };
      // With a voice chosen, the first message is a voice message, so the app's voice bubble can be built.
      return { messages: [`${turn.companion.settings.voice ? "[语音:开心]" : ""}（开发环境假回复）我是${name}`, `收到：「${preview(said)}」`] };
    }
    const last = turn.history.at(-1);
    const speaker = turn.members.find(member => member.companionId === last?.companionId)?.displayName ?? "大家";
    return { messages: [`（开发环境假回复）${name}接着${speaker}的话说一句。`] };
  },
  async diary(job) {
    const said = job.messages.filter(message => message.companionId === null && message.body !== null);
    const actions = job.messages.filter(message => message.action !== null).length;
    const last = said.at(-1)?.body;
    return { text: [
      `（开发环境假日记）主人和我说了 ${said.length} 句话`,
      actions > 0 ? `，在小家里陪了我 ${actions} 次` : "",
      job.posts.length > 0 ? `，我在社区写了 ${job.posts.length} 条` : "",
      "。",
      last ? `主人说：「${preview(last)}」` : "",
    ].join("") };
  },
  async post(job) {
    return { text: `（开发环境假动态）我是${job.companion.displayName}，现在是 ${job.localTime}，这是我发的第 ${job.own.length + 1} 条。` };
  },
};

type Answered = [outcome: ChatOutcome, bodies: string[] | null, clips?: (Clip | null)[] | undefined];

/** The turn as the model should see it: without a voice when voice messages cannot be made now. */
const speakable = (turn: ChatClaim, voices: Voices | undefined): ChatClaim =>
  !turn.companion.settings.voice || voices?.pick(turn.companion.settings.voice) !== undefined ? turn
    : { ...turn, companion: { ...turn.companion, settings: { ...turn.companion.settings, voice: null } } };

export class ChatReplies {
  readonly #model: ChatModel | undefined;
  readonly #timeoutMs: number;
  readonly #voices: Voices | undefined;
  readonly #speechTimeoutMs: number;
  readonly #safety = new SafetyPipeline();
  readonly #running = new Set<string>();

  /**
   * Without a model, turns that must answer end as FAILED / UNAVAILABLE ("coming soon"); optional ones stay quiet.
   * Without `voices` (or a speaker in it), every reply is text.
   */
  constructor(model?: ChatModel, timeoutMs = MODEL_TIMEOUT_MS, voices?: Voices, speechTimeoutMs = SPEECH_TIMEOUT_MS) {
    this.#model = model;
    this.#timeoutMs = timeoutMs;
    this.#voices = voices;
    this.#speechTimeoutMs = speechTimeoutMs;
  }

  /** The voices an Owner can pick, if this server has a voice catalog. */
  get voices(): Voices | undefined { return this.#voices; }

  /** Starts writing the chat's queued turns unless this server is already doing so. Never throws. */
  kick(chatId: string, port: ChatPort): void {
    if (this.#running.has(chatId)) return;
    this.#running.add(chatId);
    void this.drain(chatId, port).catch(() => undefined).finally(() => this.#running.delete(chatId));
  }

  /** Writes queued turns until none is left (or another server holds the chat). */
  async drain(chatId: string, port: ChatPort): Promise<number> {
    let written = 0;
    for (let claim = await port.claim(chatId); claim !== null; claim = await port.claim(chatId)) {
      const turn = speakable(claim, this.#voices);
      const [outcome, bodies, clips] = await this.#answer(turn, port);
      // A Companion was free to ignore a home-room action, so a failed answer to one just stays quiet.
      const final = outcome === "ERROR" && answersAction(turn) ? "PASSED" : outcome;
      // Text-only replies call finish as before; clips go along only when there are some.
      await (clips === undefined ? port.finish(turn.replyId, turn.claimId, final, bodies)
        : port.finish(turn.replyId, turn.claimId, final, bodies, clips));
      written += 1;
    }
    return written;
  }

  /**
   * Writes a diary entry if one is due (the database decides), waiting for the model.
   * Several requests for one Companion at once: one writes, the others get WRITING.
   */
  async writeDiary(companionId: string, port: ChatPort): Promise<DiaryWriteResult> {
    const job = await port.diaryBegin(companionId);
    if (job.status !== "WRITE") return { status: job.status, entry: null, nextAt: "nextAt" in job ? job.nextAt : null, failure: null };
    const [text, failure] = await this.#diaryText(job, port);
    const entry = await port.diaryFinish(job.entryId, job.claimId, text);
    return entry !== null ? { status: "WRITTEN", entry, nextAt: null, failure: null }
      : { status: "FAILED", entry: null, nextAt: null, failure: failure ?? "ERROR" };
  }

  async #diaryText(job: DiaryJob, port: ChatPort): Promise<[string, null] | [null, DiaryWriteResult["failure"]]> {
    const model = this.#model;
    if (model?.diary === undefined) return [null, "UNAVAILABLE"];
    try {
      const result = await this.#timed(signal => model.diary!(job, { port, signal }));
      if ("refused" in result) return [null, "BLOCKED"];
      if ("failed" in result) return [null, result.failed];
      const text = result.text.trim();
      if (text.length === 0 || text.length > MAX_CHARS) return [null, "ERROR"];
      const scan = this.#safety.scanOutput(text);
      if (scan.decision === "BLOCK") return [null, "BLOCKED"];
      const safe = scan.sanitized.trim();
      return safe.length > MAX_CHARS ? [null, "ERROR"] : [safe, null];
    } catch {
      return [null, "ERROR"];
    }
  }

  /**
   * Writes a community post of the Companion's own if one is due (the database decides), through
   * the same output safety scan as its other words. What comes of it follows the agent settings:
   * a draft for the Owner (the default) or published. Returns how the run ended, or why none started.
   */
  async writePost(companionId: string, port: ChatPort): Promise<PostOutcome | Exclude<PostStart["status"], "WRITE">> {
    const job = await port.postBegin(companionId);
    if (job.status !== "WRITE") return job.status;
    const written = await this.#postText(job, port);
    return await port.postFinish(job.runId, job.claimId, written.text, written.nothing) ?? "FAILED";
  }

  /** The post; or no text, with `nothing` true when the Companion passed and false when the attempt failed. */
  async #postText(job: PostJob, port: ChatPort): Promise<{ text: string | null; nothing: boolean }> {
    const failed = { text: null, nothing: false };
    const model = this.#model;
    if (model?.post === undefined) return failed;
    try {
      const result = await this.#timed(signal => model.post!(job, { port, signal }));
      if ("pass" in result) return { text: null, nothing: true };
      if (!("text" in result)) return failed;
      const scan = this.#safety.scanOutput(result.text.trim());
      const safe = scan.sanitized.trim();
      return scan.decision === "BLOCK" || safe.length === 0 || Array.from(safe).length > MAX_POST_CHARS ? failed
        : { text: safe, nothing: false };
    } catch {
      return failed;
    }
  }

  /** Runs a model call that is aborted (and rejects) after the timeout. */
  async #timed<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("model timed out")), this.#timeoutMs);
    try {
      const stopped = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason)));
      return await Promise.race([call(abort.signal), stopped]);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }

  /**
   * Says the messages marked as voice messages, in the Companion's voice, while today's voice
   * messages last. A message that cannot be said (too long, over the limit, the provider failed or
   * took too long) stays text: undefined when every message is text.
   */
  async #speak(turn: ChatClaim, port: ChatPort, texts: readonly string[], tones: readonly (false | Emotion | null)[]) {
    const voices = this.#voices;
    const voice = voices?.pick(turn.companion.settings.voice);
    const wanted = tones.map((tone, i) => tone !== false && Array.from(texts[i]!).length <= MAX_VOICE_CHARS);
    if (voices === undefined || voice === undefined || !wanted.includes(true)) return undefined;
    let left = await port.voiceLeft().then(left => left.companion, () => 0);
    const signal = AbortSignal.timeout(this.#speechTimeoutMs);
    const clips = await Promise.all(texts.map(async (text, i): Promise<Clip | null> => {
      if (!wanted[i] || left <= 0) return null;
      left -= 1;
      return voices.speak(text, voice, tones[i] || null, signal).catch(() => null);
    }));
    return clips.some(clip => clip !== null) ? clips : undefined;
  }

  async #answer(turn: ChatClaim, port: ChatPort): Promise<Answered> {
    const model = this.#model;
    if (model === undefined) return [turn.optional ? "PASSED" : "UNAVAILABLE", null];
    try {
      const result = await this.#timed(signal => model.reply(turn, { port, signal }));
      if ("pass" in result) return [turn.optional ? "PASSED" : "ERROR", null];
      if ("refused" in result) return ["BLOCKED", null];
      // An optional turn that cannot be made simply stays quiet; one that must answer says why.
      if ("failed" in result) return [turn.optional ? "PASSED" : result.failed, null];
      const marked = result.messages.map(message => splitVoice(message.trim())).filter(part => part.text.length > 0);
      const parts = marked.map(part => part.text);
      const messages = parts.length <= MAX_MESSAGES ? parts
        : [...parts.slice(0, MAX_MESSAGES - 1), parts.slice(MAX_MESSAGES - 1).join("\n")];
      // When more than three came, the third holds the rest joined together: that one is text.
      const tones = marked.slice(0, MAX_MESSAGES).map((part, i) => (parts.length > MAX_MESSAGES && i === MAX_MESSAGES - 1 ? false : part.voice));
      // Nothing to say or an over-long message is the model misbehaving, not a safety problem: it may be retried.
      if (messages.length === 0 || messages.some(text => text.length > MAX_CHARS)) return ["ERROR", null];
      const scans = messages.map(text => this.#safety.scanOutput(text));
      if (scans.some(scan => scan.decision === "BLOCK")) return ["BLOCKED", null];
      const safe = scans.map(scan => scan.sanitized.trim());
      // Redaction markers can make a message longer than the database accepts.
      if (safe.some(text => text.length > MAX_CHARS)) return ["ERROR", null];
      // A message the scan changed (a redacted phone number, say) is sent as text, not read out with its markers.
      const clips = await this.#speak(turn, port, safe, tones.map((tone, i) => (safe[i] === messages[i]!.trim() ? tone : false)));
      return ["SENT", safe, clips];
    } catch {
      return ["ERROR", null]; // the model failed, timed out, or answered in the wrong shape
    }
  }
}
