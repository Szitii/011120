/**
 * Writes Companion replies in the background, one at a time per chat.
 *
 * The database decides who answers and queues those turns, and decides when each message is
 * shown ("typing…" first, longer for longer messages). This file takes the turns one by one
 * (chat_claim), asks the model, runs the output safety scan and stores the result (chat_finish).
 * If the server stops halfway, the claim expires after two minutes and the next request that
 * touches the chat picks it up again.
 */
import { EncounterSafetyPipeline } from "../encounter/safety.ts";
import type { ChatClaim, ChatOutcome, ChatPort } from "./port.ts";

/**
 * One model that can speak as a Companion: 1 to 3 short messages, like texting (more are joined
 * into the third). `pass` means: stay quiet, allowed only when the turn is optional.
 */
export interface ChatModel {
  /** `signal` aborts when the call takes too long; pass it on to the model's HTTP request. */
  reply(turn: ChatClaim, signal: AbortSignal): Promise<{ messages: string[] } | { pass: true }>;
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
    if (turn.replyTo === "OWNER") {
      const said = [...turn.history].reverse().find(message => message.companionId === null)?.body ?? "";
      if (turn.optional && ![name, "大家", "你们"].some(word => said.includes(word))) return { pass: true };
      return { messages: [`（开发环境假回复）我是${name}`, `收到：「${preview(said)}」`] };
    }
    const last = turn.history.at(-1);
    const speaker = turn.members.find(member => member.companionId === last?.companionId)?.displayName ?? "大家";
    return { messages: [`（开发环境假回复）${name}接着${speaker}的话说一句。`] };
  },
};

export class ChatReplies {
  readonly #model: ChatModel | undefined;
  readonly #timeoutMs: number;
  readonly #safety = new EncounterSafetyPipeline();
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
      const [outcome, bodies] = await this.#answer(turn);
      await port.finish(turn.replyId, turn.claimId, outcome, bodies);
      written += 1;
    }
    return written;
  }

  async #answer(turn: ChatClaim): Promise<[ChatOutcome, string[] | null]> {
    if (this.#model === undefined) return [turn.optional ? "PASSED" : "UNAVAILABLE", null];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("model timed out")), this.#timeoutMs);
    try {
      const stopped = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason)));
      const result = await Promise.race([this.#model.reply(turn, abort.signal), stopped]);
      if ("pass" in result) return [turn.optional ? "PASSED" : "ERROR", null];
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
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}
