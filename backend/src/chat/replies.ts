/**
 * Writes Companion replies in the background, one at a time per chat.
 *
 * The database decides who answers and queues those turns, and decides when each message is
 * shown ("typing…" first, longer for longer messages). This file takes the turns one by one
 * (chat_claim), asks the model, runs the output safety scan and stores the result (chat_finish).
 * If the server stops halfway, the claim expires after two minutes and the next request that
 * touches the chat picks it up again.
 */
import { ACTION_TEXT, answersAction } from "./prompt.ts";
import { SafetyPipeline } from "./safety.ts";
import type { DiaryWriteResult } from "../../../contracts/chat.ts";
import type { ChatClaim, ChatOutcome, ChatPort, DiaryJob } from "./port.ts";

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

/** Something that can speak as a Companion. `signal` aborts when it takes too long: pass it on. */
export interface ChatModel {
  reply(turn: ChatClaim, context: { port: ChatPort; signal: AbortSignal }): Promise<Answer>;
  /** Writes a diary entry; without it, diary entries fail as UNAVAILABLE. */
  diary?(job: DiaryJob, context: { port: ChatPort; signal: AbortSignal }): Promise<DiaryAnswer>;
}

const MAX_MESSAGES = 3;
// Under the database's 2-minute claim, so a hung model call ends here before another server could take the turn.
const MODEL_TIMEOUT_MS = 90_000;
const MAX_CHARS = 2000;
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
      return { messages: [`（开发环境假回复）我是${name}`, `收到：「${preview(said)}」`] };
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
};

export class ChatReplies {
  readonly #model: ChatModel | undefined;
  readonly #timeoutMs: number;
  readonly #safety = new SafetyPipeline();
  readonly #running = new Set<string>();

  /** Without a model, turns that must answer end as FAILED / UNAVAILABLE ("coming soon"); optional ones stay quiet. */
  constructor(model?: ChatModel, timeoutMs = MODEL_TIMEOUT_MS) {
    this.#model = model;
    this.#timeoutMs = timeoutMs;
  }

  /** Starts writing the chat's queued turns unless this server is already doing so. Never throws. */
  kick(chatId: string, port: ChatPort): void {
    if (this.#running.has(chatId)) return;
    this.#running.add(chatId);
    void this.drain(chatId, port).catch(() => undefined).finally(() => this.#running.delete(chatId));
  }

  /** Writes queued turns until none is left (or another server holds the chat). */
  async drain(chatId: string, port: ChatPort): Promise<number> {
    let written = 0;
    for (let turn = await port.claim(chatId); turn !== null; turn = await port.claim(chatId)) {
      const [outcome, bodies] = await this.#answer(turn, port);
      // A Companion was free to ignore a home-room action, so a failed answer to one just stays quiet.
      await port.finish(turn.replyId, turn.claimId, outcome === "ERROR" && answersAction(turn) ? "PASSED" : outcome, bodies);
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

  async #answer(turn: ChatClaim, port: ChatPort): Promise<[ChatOutcome, string[] | null]> {
    const model = this.#model;
    if (model === undefined) return [turn.optional ? "PASSED" : "UNAVAILABLE", null];
    try {
      const result = await this.#timed(signal => model.reply(turn, { port, signal }));
      if ("pass" in result) return [turn.optional ? "PASSED" : "ERROR", null];
      if ("refused" in result) return ["BLOCKED", null];
      // An optional turn that cannot be made simply stays quiet; one that must answer says why.
      if ("failed" in result) return [turn.optional ? "PASSED" : result.failed, null];
      const parts = result.messages.map(text => text.trim()).filter(text => text.length > 0);
      const messages = parts.length <= MAX_MESSAGES ? parts
        : [...parts.slice(0, MAX_MESSAGES - 1), parts.slice(MAX_MESSAGES - 1).join("\n")];
      // Nothing to say or an over-long message is the model misbehaving, not a safety problem: it may be retried.
      if (messages.length === 0 || messages.some(text => text.length > MAX_CHARS)) return ["ERROR", null];
      const scans = messages.map(text => this.#safety.scanOutput(text));
      if (scans.some(scan => scan.decision === "BLOCK")) return ["BLOCKED", null];
      const safe = scans.map(scan => scan.sanitized.trim());
      // Redaction markers can make a message longer than the database accepts.
      return safe.some(text => text.length > MAX_CHARS) ? ["ERROR", null] : ["SENT", safe];
    } catch {
      return ["ERROR", null]; // the model failed, timed out, or answered in the wrong shape
    }
  }
}
