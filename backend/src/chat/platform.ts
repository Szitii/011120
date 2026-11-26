/**
 * A Companion speaking through one of the platform's models.
 *
 * Every model call is booked in the compute ledger first (chat_reserve: kill switches, today's
 * budget) and settled with the real usage after (chat_settle). A turn that may stay quiet first
 * asks the cheap decision model "should it speak?"; only a yes pays for the reply model.
 * Diary entries are booked and settled the same way (diary_reserve, reason DIARY_ENTRY), and so are
 * the community posts a Companion writes on its own (agent_auto_reserve, reason COMMUNITY_POST) and
 * the memories it notes down (memory_auto_reserve, reason MEMORY_CONSOLIDATION, on the cheap model).
 */
import type { CatalogModel, ChatCatalog } from "./models.ts";
import { PRICING_VERSION } from "./models.ts";
import type { Booking, ChatClaim, ChatPort, DiaryJob, MemoryJob, PostJob, Remembered, ReservationDecision, WorldNote } from "./port.ts";
import { decisionPrompt, diaryPrompt, memoryPrompt, parseDecision, parseMemories, parsePost, parseReply, postPrompt, replyPrompt } from "./prompt.ts";
import { usablePromptTexts, type PromptTexts } from "./prompt-texts.ts";
import type { CallModel, ModelResult } from "./providers.ts";
import type { Answer, ChatModel, DiaryAnswer, MemoryAnswer, PostAnswer } from "./replies.ts";

/** Within the ledger's limits for these reasons (16000 input; 2000 reply, 100 decision, 2000 diary output tokens). */
const MAX_INPUT_TOKENS = 16_000;
const REPLY_TOKENS = 2_000;
const DECIDE_TOKENS = 100;
const DIARY_TOKENS = 2_000;
const POST_TOKENS = 1_000;
/** The ledger allows this reason 8000 input and 1000 output tokens. */
const MEMORY_INPUT_TOKENS = 8_000;
const MEMORY_TOKENS = 300;

type Failed = { failed: "DISABLED" | "QUOTA" };
/** Books one call in the ledger, for a chat turn or a diary entry. */
type Book = (booking: Booking) => Promise<ReservationDecision>;

/** The Companion's memories, newest first, each with when it was noted down (the Owner's list; this runs as the Owner). */
export async function memoriesOf(port: ChatPort, companionId: string): Promise<Remembered[]> {
  const list = await port.memories(companionId) as { items?: { body?: unknown; createdAt?: unknown }[] };
  return (list.items ?? []).flatMap(memory => (typeof memory.body !== "string" ? []
    : [{ body: memory.body, createdAt: typeof memory.createdAt === "string" ? memory.createdAt : undefined }]));
}

/**
 * The Companion's world book (the Owner's list; this runs as the Owner). When it cannot be read (a
 * database not yet migrated, a failed query) the reply is written without it.
 */
export async function worldOf(port: ChatPort, companionId: string): Promise<WorldNote[]> {
  try {
    const list = await port.worldEntries(companionId) as { items?: { keys?: unknown; body?: unknown; enabled?: unknown }[] };
    return (list.items ?? []).flatMap(entry => (typeof entry.body !== "string" || !Array.isArray(entry.keys) ? []
      : [{ keys: entry.keys.filter((key): key is string => typeof key === "string"), body: entry.body, enabled: entry.enabled !== false }]));
  } catch {
    return [];
  }
}

/**
 * The operators' own wording of the rules (admin console, 家机说明). When it cannot be read (a
 * database not yet migrated, a failed query) the built-in wording is used: a reply is worth more
 * than the rewording.
 */
export async function textsOf(port: ChatPort): Promise<PromptTexts> {
  try {
    return usablePromptTexts(await port.promptTexts());
  } catch {
    return {};
  }
}

export class PlatformChatModel implements ChatModel {
  readonly #catalog: ChatCatalog;
  readonly #call: CallModel;

  constructor(catalog: ChatCatalog, call: CallModel) {
    this.#catalog = catalog;
    this.#call = call;
  }

  async reply(turn: ChatClaim, { port, signal, searched }: Parameters<ChatModel["reply"]>[1]): Promise<Answer> {
    const model = this.#catalog.pick(turn.companion.settings.model);
    if (model === undefined) return { failed: "UNAVAILABLE" };
    const book = (purpose: "REPLY" | "DECIDE"): Book => booking =>
      port.reserve({ ...booking, replyId: turn.replyId, claimId: turn.claimId, purpose, traceId: turn.replyId });
    // A turn that answers nobody has nothing to be judged against: the reply model itself decides whether to write.
    const judge = turn.optional && !turn.reach ? this.#catalog.decisionModel() : undefined;
    if (judge !== undefined) {
      const decided = await this.#run(port, book("DECIDE"), judge, decisionPrompt(turn), DECIDE_TOKENS, signal);
      // A judge switched off by the platform counts as no judge: the reply model decides itself.
      const quiet = "failed" in decided ? decided.failed !== "DISABLED" : decided.refused || !parseDecision(decided.text);
      if (quiet) return { pass: true };
    }
    const memories = await memoriesOf(port, turn.companion.companionId);
    const world = await worldOf(port, turn.companion.companionId);
    const texts = await textsOf(port);
    // The web: where the operators allow it, to answer the Owner, on a model that can search. The
    // prompt says so only then, so it is written for the model that actually answers.
    const browses = (m: CatalogModel): boolean => turn.canBrowse === true && turn.replyTo === "OWNER" && m.options?.webTools !== undefined;
    const result = await this.#withFallback(model, m => this.#run(port, book("REPLY"), m,
      replyPrompt(turn, memories, texts, undefined, { web: browses(m), world }), REPLY_TOKENS, signal, MAX_INPUT_TOKENS, browses(m)));
    if ("failed" in result) return result;
    if (result.web !== undefined) searched?.(result.web);
    if (result.refused) return { refused: true };
    return parseReply(result.text, turn.companion.displayName);
  }

  async diary(job: DiaryJob, { port, signal }: { port: ChatPort; signal: AbortSignal }): Promise<DiaryAnswer> {
    const prompt = diaryPrompt(job, await memoriesOf(port, job.companion.companionId), await textsOf(port));
    const result = await this.#write(job.companion.settings.model, port, booking => port.diaryReserve(job.entryId, job.claimId, booking),
      prompt, DIARY_TOKENS, signal);
    if ("failed" in result) return result;
    return result.refused ? { refused: true } : { text: result.text };
  }

  async post(job: PostJob, { port, signal }: { port: ChatPort; signal: AbortSignal }): Promise<PostAnswer> {
    const result = await this.#write(job.companion.settings.model, port, booking => port.postReserve(job.runId, job.claimId, booking),
      postPrompt(job, await textsOf(port)), POST_TOKENS, signal);
    if ("failed" in result) return result;
    return result.refused ? { refused: true } : parsePost(result.text);
  }

  /** On the cheap decision model when there is one (else the default): notes are short and need no fine writing. */
  async memory(job: MemoryJob, { port, signal }: { port: ChatPort; signal: AbortSignal }): Promise<MemoryAnswer> {
    const model = this.#catalog.decisionModel() ?? this.#catalog.defaultModel();
    if (model === undefined) return { failed: "UNAVAILABLE" };
    const book: Book = booking => port.memoryReserve(job.companion.companionId, job.claimId, booking);
    const prompt = memoryPrompt(job, await textsOf(port));
    const result = await this.#withFallback(model, m => this.#run(port, book, m, prompt, MEMORY_TOKENS, signal, MEMORY_INPUT_TOKENS));
    if ("failed" in result) return result;
    return result.refused ? { refused: true } : { memories: parseMemories(result.text, prompt.numbered) };
  }

  /** One booked call for a diary entry or a post, with the Companion's model or the default. */
  async #write(chosen: string | null, port: ChatPort, book: Book, prompt: { system: string; user: string }, maxTokens: number,
    signal: AbortSignal): Promise<ModelResult | Failed | { failed: "UNAVAILABLE" }> {
    const model = this.#catalog.pick(chosen);
    if (model === undefined) return { failed: "UNAVAILABLE" };
    return this.#withFallback(model, m => this.#run(port, book, m, prompt, maxTokens, signal));
  }

  /** The chosen model was switched off by the platform: use the default instead. */
  async #withFallback(model: CatalogModel, run: (model: CatalogModel) => Promise<ModelResult | Failed>): Promise<ModelResult | Failed> {
    const result = await run(model);
    const fallback = this.#catalog.defaultModel();
    if ("failed" in result && result.failed === "DISABLED" && fallback !== undefined && fallback !== model) return run(fallback);
    return result;
  }

  /**
   * Book, call, settle. The reservation is rounded up to whole cents and the settlement to the
   * nearest cent, so cheap calls do not each eat a cent of the daily budget. A failed call, or one
   * whose provider reported no usage, is charged its whole reservation.
   *
   * `web`: the model may search the web for this answer. What it reads comes back as input tokens
   * nobody can count beforehand, so the whole input allowance is booked; the settlement is the real usage.
   */
  async #run(port: ChatPort, book: Book, model: CatalogModel,
    prompt: { system: string; user: string }, maxTokens: number, signal: AbortSignal, maxInput = MAX_INPUT_TOKENS, web = false): Promise<ModelResult | Failed> {
    // About one token per character for Chinese, fewer for other text: a safe upper estimate.
    const inputTokens = web ? maxInput : Math.min(maxInput, prompt.system.length + prompt.user.length);
    const costMinor = Math.ceil(this.#catalog.cost(model, inputTokens, maxTokens));
    const booked = await book({
      provider: model.provider, model: model.model, pricingVersion: PRICING_VERSION, inputTokens, outputTokens: maxTokens, costMinor,
    });
    if (booked.decision === "STALE") throw new Error("the turn moved on");
    if (booked.decision !== "RESERVED") return { failed: booked.decision };
    let result: ModelResult;
    try {
      result = await this.#call(model, { ...prompt, maxTokens, signal, ...(web ? { web } : {}) });
    } catch (error) {
      await port.settle(booked.transactionId, inputTokens, maxTokens, costMinor, false);
      throw error;
    }
    if (result.inputTokens === 0 && result.outputTokens === 0) {
      await port.settle(booked.transactionId, inputTokens, maxTokens, costMinor, true);
    } else {
      await port.settle(booked.transactionId, result.inputTokens, result.outputTokens,
        Math.round(this.#catalog.cost(model, result.inputTokens, result.outputTokens)), true);
    }
    // A reply cut off at the token limit is not shown half-finished; the turn fails and can be retried.
    if (result.cutOff) throw new Error("the reply was cut off");
    return result;
  }
}
