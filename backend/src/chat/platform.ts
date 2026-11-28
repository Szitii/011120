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
import type { Booking, ChatClaim, ChatPort, DiaryJob, MemoryJob, Picture, PostJob, Remembered, ReservationDecision, SkillNote, WorldNote } from "./port.ts";
import { decisionPrompt, diaryPrompt, memoryPrompt, parseDecision, parseMemories, parsePost, parseReply, parseSeen, postPrompt, replyPrompt, seePrompt,
  withPictures } from "./prompt.ts";
import { usablePromptTexts, type PromptTexts } from "./prompt-texts.ts";
import { ProviderError, type CallModel, type ModelRequest, type ModelResult, type ToolRound } from "./providers.ts";
import type { Toolbox } from "../tools/box.ts";
import type { Answer, ChatModel, DiaryAnswer, MemoryAnswer, PostAnswer, SeeAnswer, SeeJob } from "./replies.ts";

/** Within the ledger's limits for these reasons (16000 input; 2000 reply, 100 decision, 2000 diary output tokens). */
const MAX_INPUT_TOKENS = 16_000;
const REPLY_TOKENS = 2_000;
const DECIDE_TOKENS = 100;
const DIARY_TOKENS = 2_000;
const POST_TOKENS = 1_000;
/** The ledger allows this reason 8000 input and 1000 output tokens. */
const MEMORY_INPUT_TOKENS = 8_000;
const MEMORY_TOKENS = 300;
/** A description is 200 characters at most; the room is for a model that counts differently. */
const SEE_TOKENS = 400;
/** The most a provider bills for one picture (DeepSeek: 1024 tokens; booked as that, settled as used). */
const PICTURE_TOKENS = 1_024;
/** How often the model may ask for tool calls before it has to answer, and how many calls one of its answers may ask for. */
const TOOL_ROUNDS = 4;
const CALLS_PER_ROUND = 4;

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
 * The skills that are switched on for the Companion (this runs as the Owner). When they cannot be
 * read (a database not yet migrated, a failed query) the reply is written without them.
 */
export async function skillsOf(port: ChatPort, companionId: string): Promise<SkillNote[]> {
  try {
    const list = await port.skillTexts(companionId) as { title?: unknown; body?: unknown }[];
    return list.flatMap(skill => (typeof skill.title === "string" && typeof skill.body === "string" ? [{ title: skill.title, body: skill.body }] : []));
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

  async reply(turn: ChatClaim, { port, signal, searched, backup, pictures = [], tools }: Parameters<ChatModel["reply"]>[1]): Promise<Answer> {
    const model = this.#catalog.pick(turn.companion.settings.model);
    if (model === undefined) return { failed: "UNAVAILABLE" };
    const book = (purpose: "REPLY" | "DECIDE", step?: string): Book => booking =>
      port.reserve({ ...booking, replyId: turn.replyId, claimId: turn.claimId, purpose, traceId: turn.replyId, ...(step === undefined ? {} : { step }) });
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
    const skills = await skillsOf(port, turn.companion.companionId);
    const texts = await textsOf(port);
    // The web: where the turn allows it (the operators' switch, and it answers the Owner), on a model
    // that can search. The prompt says so only then, so it is written for the model that actually answers.
    const browses = (m: CatalogModel): boolean => turn.canBrowse === true && m.options?.webTools !== undefined;
    // The pictures themselves: for a model that takes pictures, and then the transcript numbers
    // them. Any other model reads the same turn with their descriptions only.
    const sees = (m: CatalogModel): boolean => m.options?.vision === true && pictures.length > 0;
    const result = await this.#withFallback(model, m => {
      const read = sees(m) ? withPictures(turn, pictures.map(picture => picture.path)) : turn;
      // Tools, for a model that calls functions. Then the provider's own web search is not declared: it takes one or the other.
      if (tools !== undefined && m.options?.tools === true) {
        return this.#withTools(port, round => book("REPLY", round === 0 ? undefined : `tool:${round}`), m,
          replyPrompt(read, memories, texts, undefined, { world, skills, tools: true }), signal, tools,
          sees(m) ? pictures.map(picture => picture.picture) : undefined)
          // A request with tools that the provider calls wrong (a tool described in a way it will not take): the Owner
          // still gets an answer, written without tools and without a word of them, as a call of its own in the ledger.
          .catch((error: unknown) => {
            if (!(error instanceof ProviderError && error.status === 400)) throw error;
            return this.#run(port, book("REPLY", "plain"), m, replyPrompt(read, memories, texts, undefined, { world, skills }), REPLY_TOKENS, signal,
              MAX_INPUT_TOKENS, undefined, sees(m) ? pictures.map(picture => picture.picture) : undefined);
          });
      }
      return this.#run(port, book("REPLY"), m,
        replyPrompt(read, memories, texts, undefined, { web: browses(m), world, skills }), REPLY_TOKENS, signal, MAX_INPUT_TOKENS,
        browses(m) ? replyPrompt(read, memories, texts, undefined, { world, skills }) : undefined,
        sees(m) ? pictures.map(picture => picture.picture) : undefined);
    });
    if ("failed" in result) return result;
    if (result.web !== undefined) searched?.(result.web, result.inputTokens);
    if (result.backupKey) backup?.();
    if (result.refused) return { refused: true };
    return parseReply(result.text, turn.companion.displayName);
  }

  /** On the catalog's picture-reading model, booked as part of the turn's reply (an Owner on their own key pays it from their platform budget). */
  async see(job: SeeJob, { port, signal }: { port: ChatPort; signal: AbortSignal }): Promise<SeeAnswer> {
    const model = this.#catalog.visionModel();
    if (model === undefined) return { failed: "UNAVAILABLE" };
    // A ledger entry of its own, named after the file: the turn's reply is booked separately, and so is each other picture.
    const step = `see:${/[0-9a-f-]{36}/.exec(job.path)?.[0] ?? "picture"}`;
    const book: Book = booking => port.reserve({ ...booking, replyId: job.replyId, claimId: job.claimId, purpose: "REPLY", traceId: job.replyId, step });
    const result = await this.#run(port, book, model, seePrompt(job.said), SEE_TOKENS, signal, MAX_INPUT_TOKENS, undefined, [job.picture]);
    if ("failed" in result) return result;
    return result.refused ? { refused: true } : { description: parseSeen(result.text) };
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

  /**
   * A reply with tools. The model may ask for calls instead of answering; they are made (or, for a
   * call the Owner has to confirm, kept as a request) and what they returned is given back to it,
   * a few times at most, after which it must answer in words. Each answer of the model is a call
   * of its own in the ledger (`book(round)`: the first as the reply itself, the later ones by round).
   */
  async #withTools(port: ChatPort, book: (round: number) => Book, model: CatalogModel, prompt: { system: string; user: string }, signal: AbortSignal,
    box: Toolbox, images: readonly Picture[] | undefined): Promise<ModelResult | Failed> {
    let exchange: ToolRound[] = [];
    for (let round = 0; ; round += 1) {
      const answerNow = round >= TOOL_ROUNDS;
      const result = await this.#run(port, book(round), model, prompt, REPLY_TOKENS, signal, MAX_INPUT_TOKENS, undefined, images,
        { tools: box.specs, exchange, answerNow });
      if ("failed" in result || result.refused || answerNow || !result.toolCalls?.length) return result;
      const calls = result.toolCalls.slice(0, CALLS_PER_ROUND);
      const results: string[] = [];
      for (const call of calls) results.push(await box.call(call.name, call.arguments, signal));
      exchange = [...exchange, { calls, results }];
    }
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
   * `plain`: the model may search the web for this answer, and this is the prompt without the lines
   * that say so (for a provider that will not take the tool). What a search reads comes back as
   * input tokens nobody can count beforehand, and the provider takes no limit on it. So the whole
   * input allowance is booked (the most the ledger books for one answer), and the settlement is the
   * real usage, also when that is more: the day's budget then shrinks by what was really used, a
   * wallet is charged no more than was held for it, and the trace carries the number (`webTokens`).
   *
   * `images`: pictures that go with the user text, for a model that takes them. `functions`: the
   * tools declared for this answer and what was called so far (see #withTools).
   */
  async #run(port: ChatPort, book: Book, model: CatalogModel, prompt: { system: string; user: string }, maxTokens: number,
    signal: AbortSignal, maxInput = MAX_INPUT_TOKENS, plain?: { system: string; user: string },
    images?: readonly Picture[], functions?: Pick<ModelRequest, "tools" | "exchange" | "answerNow">): Promise<ModelResult | Failed> {
    // About one token per character for Chinese, fewer for other text: a safe upper estimate. A picture counts as the
    // most it can be billed; the tools and what they returned so far count as the text they are sent as.
    const inputTokens = plain ? maxInput
      : Math.min(maxInput, prompt.system.length + prompt.user.length + PICTURE_TOKENS * (images?.length ?? 0)
        + (functions === undefined ? 0 : JSON.stringify([functions.tools, functions.exchange]).length));
    const costMinor = Math.ceil(this.#catalog.cost(model, inputTokens, maxTokens));
    const booked = await book({
      provider: model.provider, model: model.model, pricingVersion: PRICING_VERSION, inputTokens, outputTokens: maxTokens, costMinor,
    });
    if (booked.decision === "STALE") throw new Error("the turn moved on");
    if (booked.decision !== "RESERVED") return { failed: booked.decision };
    let result: ModelResult;
    try {
      result = await this.#call(model, { ...prompt, maxTokens, signal, ...(plain ? { web: { without: plain } } : {}),
        ...(images?.length ? { images } : {}), ...functions });
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
