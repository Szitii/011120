import type { ChatSettings } from "../../../contracts/chat.ts";

/** What the server needs to write one Companion reply (from chat_claim). */
export interface ChatClaim {
  chatId: string;
  replyId: string;
  claimId: string;
  /** What this turn answers: the Owner's message, or another Companion. */
  replyTo: "OWNER" | "COMPANION";
  /** true: it may stay quiet (answer { pass: true }) if the message does not concern it. */
  optional: boolean;
  /** A one-to-one chat (otherwise a group). */
  direct: boolean;
  companion: { companionId: string; displayName: string; identity: unknown; settings: ChatSettings };
  members: { companionId: string; displayName: string }[];
  /** The last 30 shown messages, oldest first; companionId null is the Owner. */
  history: { companionId: string | null; body: string; mentions: string[]; sentAt: string }[];
}

export type ChatOutcome = "SENT" | "PASSED" | "BLOCKED" | "ERROR" | "UNAVAILABLE" | "DISABLED" | "QUOTA";

/** One model call to book in the compute ledger before it starts (chat_reserve). */
export interface ChatReservation {
  replyId: string;
  claimId: string;
  /** REPLY: writing the answer. DECIDE: the cheap "should it speak?" check. */
  purpose: "REPLY" | "DECIDE";
  provider: string;
  model: string;
  pricingVersion: string;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
  traceId: string;
}

/** RESERVED: go ahead. STALE: the turn moved on. DISABLED: switched off. QUOTA: today's budget is used up. */
export type ReservationDecision = { decision: "RESERVED"; transactionId: string } | { decision: "STALE" | "DISABLED" | "QUOTA" };

/** Every call runs as the signed-in Owner; the database checks ownership. */
export interface ChatPort {
  open(companionIds: string[], title: string | null, keyHash: string): Promise<unknown>;
  list(): Promise<unknown>;
  read(chatId: string, beforeAt: string | null, beforeId: string | null): Promise<unknown>;
  send(chatId: string, body: string, mentions: string[], keyHash: string): Promise<unknown>;
  retry(chatId: string, messageId: string): Promise<unknown>;
  remove(chatId: string): Promise<unknown>;
  settings(companionId: string): Promise<unknown>;
  saveSettings(companionId: string, settings: ChatSettings): Promise<unknown>;
  /** Server only: the next reply to write, or null. */
  claim(chatId: string): Promise<ChatClaim | null>;
  /** Server only: `bodies` are 1 to 3 messages for SENT, else null. False when the claim is stale. */
  finish(replyId: string, claimId: string, outcome: ChatOutcome, bodies: string[] | null): Promise<boolean>;
  /** Server only: book a model call and mark it started. */
  reserve(input: ChatReservation): Promise<ReservationDecision>;
  /** Server only: settle a started call with real usage (ok false: it failed). */
  settle(transactionId: string, inputTokens: number, outputTokens: number, costMinor: number, ok: boolean): Promise<void>;
  /** Whether each provider/model is switched on, in order. */
  modelsEnabled(models: readonly { provider: string; model: string }[]): Promise<boolean[]>;
}
