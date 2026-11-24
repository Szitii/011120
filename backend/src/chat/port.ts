import type { ChatSettings, DiaryEntry, DiarySettings } from "../../../contracts/chat.ts";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import type { Connection } from "../connections/model.ts";
import type { Clip } from "./voices.ts";

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
  /** The last 30 shown messages, oldest first; companionId null is the Owner. An action has no body. */
  history: {
    companionId: string | null; body: string | null; action: CompanionAction | null; mentions: string[]; sentAt: string;
    /** A voice message (the body is what was said). */
    voice?: boolean;
  }[];
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

/** A diary entry to write (diary_begin said WRITE): the Companion and what happened since its last entry. */
export interface DiaryJob {
  status: "WRITE";
  entryId: string;
  claimId: string;
  companion: ChatClaim["companion"];
  /** The one-to-one chat, oldest first; companionId null is the Owner. An action has no body. */
  messages: { companionId: string | null; body: string | null; action: CompanionAction | null; sentAt: string }[];
  /** Its own community posts and comments, oldest first. */
  posts: { kind: "POST" | "COMMENT"; body: string; at: string }[];
}

/** diary_begin: a job, or why nothing is written now. */
export type DiaryStart = DiaryJob | { status: "OFF" | "WRITING" | "NOTHING_NEW" } | { status: "NOT_DUE"; nextAt: string };

/** What a model call costs, before it starts; the caller adds which turn or entry it is for. */
export type Booking = Pick<ChatReservation, "provider" | "model" | "pricingVersion" | "inputTokens" | "outputTokens" | "costMinor">;

/** Every call runs as the signed-in Owner; the database checks ownership. */
export interface ChatPort {
  open(companionIds: string[], title: string | null, keyHash: string): Promise<unknown>;
  list(): Promise<unknown>;
  read(chatId: string, beforeAt: string | null, beforeId: string | null): Promise<unknown>;
  send(chatId: string, body: string, mentions: string[], keyHash: string): Promise<unknown>;
  retry(chatId: string, messageId: string): Promise<unknown>;
  /** A home-room action, recorded in the one-to-one chat with the Companion. */
  act(companionId: string, action: CompanionAction, keyHash: string): Promise<unknown>;
  remove(chatId: string): Promise<unknown>;
  /** The Owner has read up to this message (only moves forward); returns the chat. */
  markRead(chatId: string, messageId: string): Promise<unknown>;
  /** Every unread count for the tab badges. */
  badges(): Promise<unknown>;
  anniversary(companionId: string): Promise<unknown>;
  saveAnniversary(companionId: string, startDate: string | null, timeZone: string, revision: number): Promise<unknown>;
  settings(companionId: string): Promise<unknown>;
  /** Every memory of the Companion, newest first ({ items }). */
  memories(companionId: string): Promise<unknown>;
  addMemory(companionId: string, body: string, keyHash: string): Promise<unknown>;
  deleteMemory(companionId: string, memoryId: string): Promise<unknown>;
  /** How the Companion speaks, without the secret. */
  connectionView(companionId: string): Promise<unknown>;
  /** Server only: save a tested connection; `secret` is already sealed. */
  saveConnection(companionId: string, connection: Connection, hint: string): Promise<unknown>;
  /** Back to the platform's models. */
  removeConnection(companionId: string): Promise<unknown>;
  /** Server only: the connection with its sealed secret, or null for the platform. */
  connection(companionId: string): Promise<Connection | null>;
  saveSettings(companionId: string, settings: ChatSettings): Promise<unknown>;
  /** Server only: the next reply to write, or null. */
  claim(chatId: string): Promise<ChatClaim | null>;
  /**
   * Server only: `bodies` are 1 to 3 messages for SENT, else null; `clips` (SENT only) has one entry
   * per body, a Clip for a voice message or null for text. False when the claim is stale.
   */
  finish(replyId: string, claimId: string, outcome: ChatOutcome, bodies: string[] | null, clips?: readonly (Clip | null)[]): Promise<boolean>;
  /** Server only: how many voice messages the Owner may still get from Companions today, and send. */
  voiceLeft(): Promise<{ companion: number; owner: number }>;
  /** Server only: the Owner's voice message, `body` being what the server recognised in `recording`. */
  sendVoice(chatId: string, body: string, recording: { mime: string; durationMs: number; bytes: Uint8Array }, keyHash: string): Promise<unknown>;
  /** The audio of a shown voice message in the Owner's chat (NOT_FOUND otherwise). */
  audio(chatId: string, messageId: string): Promise<{ mime: string; bytes: Uint8Array }>;
  /** Server only: book a model call and mark it started. */
  reserve(input: ChatReservation): Promise<ReservationDecision>;
  /** Server only: settle a started call with real usage (ok false: it failed). */
  settle(transactionId: string, inputTokens: number, outputTokens: number, costMinor: number, ok: boolean): Promise<void>;
  /** Whether each provider/model is switched on, in order. */
  modelsEnabled(models: readonly { provider: string; model: string }[]): Promise<boolean[]>;
  /** A page of the Companion's diary, newest first. */
  diary(companionId: string, beforeAt: string | null, beforeId: string | null): Promise<unknown>;
  deleteDiary(companionId: string, entryId: string): Promise<unknown>;
  diarySettings(companionId: string): Promise<unknown>;
  saveDiarySettings(companionId: string, settings: DiarySettings): Promise<unknown>;
  /** Server only: start an entry if one is due. */
  diaryBegin(companionId: string): Promise<DiaryStart>;
  /** Server only: book the model call for an entry (like reserve). */
  diaryReserve(entryId: string, claimId: string, booking: Booking): Promise<ReservationDecision>;
  /** Server only: keep the entry (body) or mark the attempt failed (null). The entry, or null if not kept. */
  diaryFinish(entryId: string, claimId: string, body: string | null): Promise<DiaryEntry | null>;
}
