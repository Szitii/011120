/**
 * Writes Companion replies in the background, one at a time per chat.
 *
 * The database decides who answers and queues those turns, and decides when each message is
 * shown ("typing…" first, longer for longer messages). This file takes the turns one by one
 * (chat_claim), asks the model, runs the output safety scan, says the messages the model marked
 * as voice messages aloud (when the Companion has a voice) and stores the result (chat_finish).
 * If the server stops halfway, the claim expires after two minutes and the next request that
 * touches the chat picks it up again.
 *
 * After the replies of a one-to-one chat the Companion may note down what is worth remembering
 * (remember); the database decides whether the Owner asked for it and enough was said. A note
 * may take the place of an older memory of its own that no longer holds.
 *
 * A Companion also writes without being written to (reachOut): when the Owner has been away and
 * asked for that, and to deliver a reminder it promised. The scheduler asks every minute and the
 * database decides; such a turn is written like any other.
 */
import { ACTION_TEXT, MAX_NOTES, answersAction, localStamp, splitAction, splitReminders, splitVoice } from "./prompt.ts";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { SafetyPipeline } from "./safety.ts";
import type { DiaryWriteResult } from "../../../contracts/chat.ts";
import type {
  ChatClaim, ChatOutcome, ChatPort, DiaryJob, MemoryJob, MemoryNote, MemoryStart, PostJob, PostOutcome, PostStart, ReachStart, ReminderChange,
} from "./port.ts";
import { SpeechError, type Clip, type Emotion, type Voices } from "./voices.ts";

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

/** What the model found worth remembering: 0 to 2 sentences, each new or in place of an older memory. */
export type MemoryAnswer = { memories: MemoryNote[] } | Exclude<DiaryAnswer, { text: string }>;

/**
 * Why one message of a reply is, or is not, a voice message. SPOKEN: a clip was made. NO_VOICE: the
 * Owner chose none. VOICE_UNAVAILABLE: the chosen voice cannot be made on this server. NO_MARK: the
 * model wrote it as text. MERGED: lines past the third, joined. REDACTED: the safety scan changed
 * it. TOO_LONG: over 120 characters. OVER_LIMIT: today's voice messages are used up. LIMIT_UNKNOWN:
 * the count could not be read. SPEECH_TIMEOUT and SPEECH_FAILED (with the provider's status when
 * it gave one): the speech provider.
 */
export type VoiceResult = "SPOKEN" | "NO_VOICE" | "VOICE_UNAVAILABLE" | "NO_MARK" | "MERGED" | "REDACTED" | "TOO_LONG"
  | "OVER_LIMIT" | "LIMIT_UNKNOWN" | "SPEECH_TIMEOUT" | `SPEECH_FAILED${string}`;

/**
 * One line per turn, so "why did this reply come as text?" and "why did it write to me at nine?"
 * can be answered afterwards: ids, what the turn answers (SELF: it wrote on its own; REMINDER: a
 * reminder), the channel, how long the model and the speech took, how the turn ended, and why
 * each message is or is not a voice message. Never what was said, a memory, a key, audio or a
 * provider's own words. `stored` false with a SPOKEN message: the clip was made but the reply was
 * not saved. `web`: OFF when the model was not offered the web; else how many searches it ran, or
 * REFUSED when the provider would not take the tool and the reply was written without.
 * `webTokens`: for a reply that was offered the web, the input tokens it was billed, which hold
 * what the searches brought back (16,000 are booked for a reply; a searched one may come back with more).
 */
export interface ReplyTrace {
  event: "chat_reply";
  chatId: string;
  replyId: string;
  companionId: string;
  replyTo: ChatClaim["replyTo"];
  channel: "PLATFORM" | "BYOK" | "EXTERNAL";
  outcome: ChatOutcome;
  modelMs: number;
  speechMs: number;
  voice: VoiceResult[];
  stored: boolean;
  web: number | "REFUSED" | "OFF";
  webTokens?: number;
}

/**
 * One line per attempt at noting memories down, so "why does it remember this, and why not that?"
 * has somewhere to start: how it ended, how many sentences the model gave and the scan let through
 * (`kept`), and how many of them became a new memory or took the place of an older one. Never the
 * sentences themselves.
 */
export interface MemoryTrace {
  event: "chat_memory";
  companionId: string;
  outcome: "DONE" | "FAILED";
  kept: number;
  added: number;
  replaced: number;
}

/**
 * Something that can speak as a Companion. `signal` aborts when it takes too long: pass it on.
 * A model that answers through the Owner's own key or agent says so with `via`, for the trace;
 * one that was offered the web says with `searched` how many searches it ran (or that it was refused)
 * and how many input tokens the answer was billed.
 */
export interface ChatModel {
  reply(turn: ChatClaim, context: { port: ChatPort; signal: AbortSignal; via?: (channel: "BYOK" | "EXTERNAL") => void;
    searched?: (searches: number | "REFUSED", inputTokens: number) => void }): Promise<Answer>;
  /** Writes a diary entry; without it, diary entries fail as UNAVAILABLE. */
  diary?(job: DiaryJob, context: { port: ChatPort; signal: AbortSignal }): Promise<DiaryAnswer>;
  /** Writes a community post of its own; without it, such posts fail. */
  post?(job: PostJob, context: { port: ChatPort; signal: AbortSignal }): Promise<PostAnswer>;
  /** Picks what is worth remembering from the chat; without it, nothing is noted down. */
  memory?(job: MemoryJob, context: { port: ChatPort; signal: AbortSignal }): Promise<MemoryAnswer>;
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
    if (turn.reach?.kind === "REMINDER") return { messages: [`（开发环境假回复）到时间啦：${turn.reach.note}`] };
    if (turn.reach) return { messages: [`（开发环境假回复）${name}主动来找你了`] };
    if (answersAction(turn)) {
      const action = [...turn.history].reverse().find(message => message.action !== null && message.companionId === null)?.action;
      return { messages: [`（开发环境假回复）${name}知道你${action ? ACTION_TEXT[action] : "来过"}`] };
    }
    if (turn.replyTo === "OWNER") {
      const said = [...turn.history].reverse().find(message => message.companionId === null)?.body ?? "";
      if (turn.optional && ![name, "大家", "你们"].some(word => said.includes(word))) return { pass: true };
      // A message that says 提醒 sets a reminder for the minute after next (so it is at least a minute
      // away), and 取消提醒 cancels the first waiting one: the app's reminder line and the reminder itself can be built.
      const remind = !turn.canRemind ? [] : said.includes("取消提醒") ? ["[取消提醒:1]"]
        : said.includes("提醒") ? [`[提醒:${localStamp(new Date(Date.now() + 120_000), turn.timeZone)} 开发环境的假提醒]`] : [];
      // With a voice chosen, the first message is a voice message, so the app's voice bubble can be built.
      return { messages: [`${turn.companion.settings.voice ? "[语音:开心]" : ""}（开发环境假回复）我是${name}`, `收到：「${preview(said)}」`, ...remind] };
    }
    const last = turn.history.at(-1);
    const speaker = turn.members.find(member => member.companionId === last?.companionId)?.displayName ?? "大家";
    return { messages: [`（开发环境假回复）${name}接着${speaker}的话说一句。`] };
  },
  async diary(job) {
    const said = job.messages.filter(message => message.companionId === null && message.body !== null);
    const actions = job.messages.filter(message => message.action !== null && message.companionId === null).length;
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
  async memory(job) {
    const last = job.messages.findLast(message => message.companionId === null)?.body ?? "";
    return { memories: [{ body: `（开发环境假记忆）主人说过：「${preview(last)}」`, replaces: null }] };
  },
};

type Answered = [outcome: ChatOutcome, bodies: string[] | null, clips?: (Clip | null)[] | undefined, action?: CompanionAction | undefined,
  reminders?: ReminderChange | undefined];

/** What a reminder says when the model has no words of its own for it: the reminder is delivered all the same. */
const plainReminder = (note: string): string => `提醒你：${note}`;

/** The turn as the model should see it: without a voice when voice messages cannot be made now. */
const speakable = (turn: ChatClaim, voices: Voices | undefined): ChatClaim =>
  !turn.companion.settings.voice || voices?.pick(turn.companion.settings.voice) !== undefined ? turn
    : { ...turn, companion: { ...turn.companion, settings: { ...turn.companion.settings, voice: null } } };

export class ChatReplies {
  readonly #model: ChatModel | undefined;
  readonly #timeoutMs: number;
  readonly #voices: Voices | undefined;
  readonly #speechTimeoutMs: number;
  readonly #trace: (trace: ReplyTrace | MemoryTrace) => void;
  readonly #safety = new SafetyPipeline();
  readonly #running = new Set<string>();

  /**
   * Without a model, turns that must answer end as FAILED / UNAVAILABLE ("coming soon"); optional ones stay quiet.
   * Without `voices` (or a speaker in it), every reply is text. `trace` gets one record per turn,
   * and one per attempt at noting memories down.
   */
  constructor(model?: ChatModel, timeoutMs = MODEL_TIMEOUT_MS, voices?: Voices, speechTimeoutMs = SPEECH_TIMEOUT_MS,
    trace: (trace: ReplyTrace | MemoryTrace) => void = () => undefined) {
    this.#model = model;
    this.#timeoutMs = timeoutMs;
    this.#voices = voices;
    this.#speechTimeoutMs = speechTimeoutMs;
    this.#trace = trace;
  }

  /** The voices an Owner can pick, if this server has a voice catalog. */
  get voices(): Voices | undefined { return this.#voices; }

  /** Starts writing the chat's queued turns unless this server is already doing so. Never throws. */
  kick(chatId: string, port: ChatPort): void {
    if (this.#running.has(chatId)) return;
    this.#running.add(chatId);
    void this.drain(chatId, port).catch(() => undefined).finally(() => this.#running.delete(chatId));
  }

  /**
   * Writes queued turns until none is left (or another server holds the chat). Then, if the
   * Companion of a one-to-one chat answered, it notes its memories down when that is due.
   */
  async drain(chatId: string, port: ChatPort): Promise<number> {
    let written = 0;
    let remember: string | undefined;
    for (let claim = await port.claim(chatId); claim !== null; claim = await port.claim(chatId)) {
      const turn = speakable(claim, this.#voices);
      const trace: ReplyTrace = {
        event: "chat_reply", chatId: turn.chatId, replyId: turn.replyId, companionId: turn.companion.companionId, replyTo: turn.replyTo,
        channel: "PLATFORM", outcome: "ERROR", modelMs: 0, speechMs: 0, voice: [], stored: false, web: "OFF",
      };
      const silent = turn.companion.settings.voice ? null : claim.companion.settings.voice ? "VOICE_UNAVAILABLE" : "NO_VOICE";
      const [outcome, bodies, clips, action, reminders] = await this.#answer(turn, port, trace, silent);
      // A Companion was free to ignore a home-room action, so a failed answer to one just stays quiet.
      // Nobody waits for a message it writes on its own: whatever went wrong with one, nothing is shown.
      const final = (outcome === "ERROR" && answersAction(turn)) || (outcome !== "SENT" && turn.reach) ? "PASSED" : outcome;
      trace.outcome = final;
      try {
        trace.stored = await port.finish(turn.replyId, turn.claimId, final, bodies, clips, action, reminders);
      } finally {
        this.#trace(trace);
      }
      if (final === "SENT" && turn.direct) remember = turn.companion.companionId;
      written += 1;
    }
    // The chat is free for the next message while the memories are noted down.
    this.#running.delete(chatId);
    if (remember) await this.remember(remember, port);
    return written;
  }

  /**
   * Queues a turn of the Companion's own if one is due (a reminder to deliver, or writing first
   * after the Owner was away: the database decides) and writes it. Returns whether one was queued,
   * or why not.
   */
  async reachOut(companionId: string, port: ChatPort): Promise<ReachStart["status"]> {
    const begun = await port.reachBegin(companionId);
    if (begun.status === "QUEUED") await this.drain(begun.chatId, port);
    return begun.status;
  }

  /**
   * Notes down what is worth remembering from the Companion's one-to-one chat, if the Owner asked
   * for it and enough was said since the last time (the database decides), through the same output
   * safety scan as its other words. Returns how it ended, or why nothing started. Never throws.
   */
  async remember(companionId: string, port: ChatPort): Promise<"DONE" | "FAILED" | Exclude<MemoryStart["status"], "WRITE">> {
    const trace: MemoryTrace = { event: "chat_memory", companionId, outcome: "FAILED", kept: 0, added: 0, replaced: 0 };
    try {
      const job = await port.memoryBegin(companionId);
      if (job.status !== "WRITE") return job.status;
      try {
        const notes = await this.#notes(job, port);
        const stored = await port.memoryFinish(companionId, job.claimId, notes);
        if (stored.accepted && notes !== null) Object.assign(trace, { outcome: "DONE", kept: notes.length, added: stored.added, replaced: stored.replaced });
      } finally {
        this.#trace(trace);
      }
      return trace.outcome;
    } catch {
      return "FAILED";
    }
  }

  /**
   * The sentences to keep (maybe none), or null when the attempt failed. One the scan would change
   * is not kept, and a chat the provider refuses to read is not read again.
   */
  async #notes(job: MemoryJob, port: ChatPort): Promise<MemoryNote[] | null> {
    const model = this.#model;
    if (model?.memory === undefined) return null;
    try {
      const result = await this.#timed(signal => model.memory!(job, { port, signal }));
      if ("failed" in result) return null;
      if ("refused" in result) return [];
      return result.memories.map(note => ({ ...note, body: note.body.trim() }))
        .filter(note => note.body.length > 0 && this.#safety.scanOutput(note.body).decision === "ALLOW").slice(0, MAX_NOTES);
    } catch {
      return null;
    }
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
   * Says the messages still to be said (`results` null), in the Companion's voice, while today's
   * voice messages last. A message that cannot be said (over the limit, the provider failed or took
   * too long) stays text, and `results` says why: undefined when every message is text.
   */
  async #speak(turn: ChatClaim, port: ChatPort, texts: readonly string[], tones: readonly (Emotion | null)[],
    results: (VoiceResult | null)[], trace: ReplyTrace) {
    const voices = this.#voices;
    const voice = voices?.pick(turn.companion.settings.voice);
    if (voices === undefined || voice === undefined || !results.includes(null)) return undefined;
    const started = Date.now();
    let left = await port.voiceLeft().then(left => left.companion, () => null);
    const signal = AbortSignal.timeout(this.#speechTimeoutMs);
    const clips = await Promise.all(texts.map(async (text, i): Promise<Clip | null> => {
      if (results[i] !== null) return null;
      if (left === null || left <= 0) {
        results[i] = left === null ? "LIMIT_UNKNOWN" : "OVER_LIMIT";
        return null;
      }
      left -= 1;
      try {
        const clip = await voices.speak(text, voice, tones[i]!, signal);
        // Booked for the cost page; a booking that fails must not cost the Owner the message.
        await port.voiceUsed("SPEAK", clip.characters).catch(() => undefined);
        results[i] = "SPOKEN";
        return clip;
      } catch (error) {
        results[i] = signal.aborted ? "SPEECH_TIMEOUT" : error instanceof SpeechError ? `SPEECH_FAILED_${error.code}` : "SPEECH_FAILED";
        return null;
      }
    }));
    trace.speechMs = Date.now() - started;
    return clips.some(clip => clip !== null) ? clips : undefined;
  }

  /** `silent`: why this Companion has no voice messages now, or null when it has a voice. */
  async #answer(turn: ChatClaim, port: ChatPort, trace: ReplyTrace, silent: VoiceResult | null): Promise<Answered> {
    const answered = await this.#write(turn, port, trace, silent);
    if (turn.reach?.kind !== "REMINDER") return answered;
    // A reminder is delivered whatever happened to the model (none, switched off, out of budget, a
    // refusal, an answer that could not be used): in plain words. Its note passed the scan when it was set.
    // An action and not a word (it hugged the Owner and said nothing): the action stays, and the words are added.
    const [, bodies, , action] = answered;
    return bodies?.length ? answered : ["SENT", [plainReminder(turn.reach.note)], undefined, action];
  }

  async #write(turn: ChatClaim, port: ChatPort, trace: ReplyTrace, silent: VoiceResult | null): Promise<Answered> {
    const model = this.#model;
    if (model === undefined) return [turn.optional ? "PASSED" : "UNAVAILABLE", null];
    try {
      const started = Date.now();
      const result = await this.#timed(signal => model.reply(turn, { port, signal, via: channel => { trace.channel = channel; },
        searched: (searches, inputTokens) => { trace.web = searches; trace.webTokens = inputTokens; } }))
        .finally(() => { trace.modelMs = Date.now() - started; });
      if ("pass" in result) return [turn.optional ? "PASSED" : "ERROR", null];
      if ("refused" in result) return ["BLOCKED", null];
      // An optional turn that cannot be made simply stays quiet; one that must answer says why.
      if ("failed" in result) return [turn.optional ? "PASSED" : result.failed, null];
      // An action of its own, where it may do one; its mark is removed from the text either way.
      const acted = splitAction(result.messages);
      const action = turn.canAct && acted.action !== null ? acted.action : undefined;
      // The same for reminders: set and cancelled only while it answers the Owner where it may, and
      // a note the safety scan would stop or change is not kept as a reminder.
      const reminded = splitReminders(acted.messages, turn.reminders);
      const cancel = turn.canRemind ? reminded.cancel : [];
      const set = turn.canRemind && reminded.set !== undefined && this.#safety.scanOutput(reminded.set.note).decision === "ALLOW" ? reminded.set : undefined;
      const reminders: ReminderChange | undefined = set === undefined && cancel.length === 0 ? undefined
        : { ...(set && { set }), ...(cancel.length > 0 && { cancel }) };
      const marked = reminded.messages.map(message => splitVoice(message.trim())).filter(part => part.text.length > 0);
      const parts = marked.map(part => part.text);
      const messages = parts.length <= MAX_MESSAGES ? parts
        : [...parts.slice(0, MAX_MESSAGES - 1), parts.slice(MAX_MESSAGES - 1).join("\n")];
      // Nothing to say (and nothing done) or an over-long message is the model misbehaving, not a safety problem: it may be retried.
      if ((messages.length === 0 && action === undefined) || messages.some(text => text.length > MAX_CHARS)) return ["ERROR", null];
      const scans = messages.map(text => this.#safety.scanOutput(text));
      if (scans.some(scan => scan.decision === "BLOCK")) return ["BLOCKED", null];
      const safe = scans.map(scan => scan.sanitized.trim());
      // Redaction markers can make a message longer than the database accepts.
      if (safe.some(text => text.length > MAX_CHARS)) return ["ERROR", null];
      // Why each message is text, or null when it is to be said. When more than three came, the third
      // holds the rest joined together: that one is text. So is a message the scan changed (a redacted
      // phone number, say): it is not read out with its markers.
      const results = safe.map((text, i): VoiceResult | null => silent
        ?? (parts.length > MAX_MESSAGES && i === MAX_MESSAGES - 1 ? "MERGED"
          : marked[i]!.voice === false ? "NO_MARK"
          : text !== messages[i]!.trim() ? "REDACTED"
          : Array.from(text).length > MAX_VOICE_CHARS ? "TOO_LONG" : null));
      const clips = await this.#speak(turn, port, safe, marked.map(part => part.voice || null), results, trace);
      trace.voice = results.map(result => result ?? "VOICE_UNAVAILABLE");
      return ["SENT", safe, clips, action, reminders];
    } catch {
      return ["ERROR", null]; // the model failed, timed out, or answered in the wrong shape
    }
  }
}
