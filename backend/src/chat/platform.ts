/**
 * A Companion speaking through one of the platform's models.
 *
 * Every model call is booked in the compute ledger first (chat_reserve: kill switches, today's
 * budget) and settled with the real usage after (chat_settle). A turn that may stay quiet first
 * asks the cheap decision model "should it speak?"; only a yes pays for the reply model.
 */
import type { CatalogModel, ChatCatalog } from "./models.ts";
import { PRICING_VERSION } from "./models.ts";
import type { ChatClaim, ChatPort } from "./port.ts";
import { decisionPrompt, parseDecision, parseReply, replyPrompt } from "./prompt.ts";
import type { CallModel, ModelResult } from "./providers.ts";
import type { Answer, ChatModel } from "./replies.ts";

/** Within the ledger's limits for these reasons (16000 input, 2000 / 100 output tokens). */
const MAX_INPUT_TOKENS = 16_000;
const REPLY_TOKENS = 2_000;
const DECIDE_TOKENS = 100;

type Failed = { failed: "DISABLED" | "QUOTA" };

export class PlatformChatModel implements ChatModel {
  readonly #catalog: ChatCatalog;
  readonly #call: CallModel;

  constructor(catalog: ChatCatalog, call: CallModel) {
    this.#catalog = catalog;
    this.#call = call;
  }

  async reply(turn: ChatClaim, { port, signal }: { port: ChatPort; signal: AbortSignal }): Promise<Answer> {
    const model = this.#catalog.pick(turn.companion.settings.model);
    if (model === undefined) return { failed: "UNAVAILABLE" };
    const judge = turn.optional ? this.#catalog.decisionModel() : undefined;
    if (judge !== undefined) {
      const decided = await this.#run(port, turn, "DECIDE", judge, decisionPrompt(turn), DECIDE_TOKENS, signal);
      if ("failed" in decided || decided.refused || !parseDecision(decided.text)) return { pass: true };
    }
    let result = await this.#run(port, turn, "REPLY", model, replyPrompt(turn), REPLY_TOKENS, signal);
    // The chosen model was switched off by the platform: answer with the default instead.
    const fallback = this.#catalog.defaultModel();
    if ("failed" in result && result.failed === "DISABLED" && fallback !== undefined && fallback !== model) {
      result = await this.#run(port, turn, "REPLY", fallback, replyPrompt(turn), REPLY_TOKENS, signal);
    }
    if ("failed" in result) return result;
    if (result.refused) return { refused: true };
    return parseReply(result.text, turn.companion.displayName);
  }

  /**
   * Book, call, settle. The reservation is rounded up to whole cents and the settlement to the
   * nearest cent, so cheap calls do not each eat a cent of the daily budget. A failed call, or one
   * whose provider reported no usage, is charged its whole reservation.
   */
  async #run(port: ChatPort, turn: ChatClaim, purpose: "REPLY" | "DECIDE", model: CatalogModel,
    prompt: { system: string; user: string }, maxTokens: number, signal: AbortSignal): Promise<ModelResult | Failed> {
    // About one token per character for Chinese, fewer for other text: a safe upper estimate.
    const inputTokens = Math.min(MAX_INPUT_TOKENS, prompt.system.length + prompt.user.length);
    const costMinor = Math.ceil(this.#catalog.cost(model, inputTokens, maxTokens));
    const booked = await port.reserve({
      replyId: turn.replyId, claimId: turn.claimId, purpose, provider: model.provider, model: model.model,
      pricingVersion: PRICING_VERSION, inputTokens, outputTokens: maxTokens, costMinor, traceId: turn.replyId,
    });
    if (booked.decision === "STALE") throw new Error("the turn moved on");
    if (booked.decision !== "RESERVED") return { failed: booked.decision };
    let result: ModelResult;
    try {
      result = await this.#call(model, { ...prompt, maxTokens, signal });
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
