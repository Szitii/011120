import type { ChatSettings, DiaryEntry, DiarySettings } from "../../../contracts/chat.ts";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import type { Connection } from "../connections/model.ts";
import type { Clip } from "./voices.ts";

/** What the server needs to write one Companion reply (from chat_claim). */
export interface ChatClaim {
  chatId: string;
  replyId: string;
  claimId: string;
  /**
   * What this turn answers: the Owner's message, another Companion, or nobody (SELF: it writes on
   * its own; REMINDER: it delivers a reminder). For the last two, `reach` says more.
   */
  replyTo: "OWNER" | "COMPANION" | "SELF" | "REMINDER";
  /** true: it may stay quiet (answer { pass: true }) if the message does not concern it. */
  optional: boolean;
  /** A one-to-one chat (otherwise a group). */
  direct: boolean;
  companion: { companionId: string; displayName: string; identity: unknown; settings: ChatSettings };
  members: { companionId: string; displayName: string; avatar?: string | null }[];
  /** The last 30 shown messages, oldest first; companionId null is the Owner. An action has no body. */
  history: {
    companionId: string | null; body: string | null; action: CompanionAction | null; mentions: string[]; sentAt: string;
    /** A voice message (the body is what was said). */
    voice?: boolean;
  }[];
  /** The Owner's time zone (an IANA name); left out by an older database: Asia/Shanghai. */
  timeZone?: string;
  /** What the Companion calls the Owner: the chat setting, else their community name; null or left out: no name. */
  ownerName?: string | null;
  /** true: in this reply it may do one home-room action to the Owner (one-to-one chats, when switched on). */
  canAct?: boolean;
  /** Why it writes without being written to; null or left out for an ordinary turn. */
  reach?: Reach | null;
  /** true: in this reply it may set a reminder for the Owner and cancel ones it set (answering the Owner one-to-one, when switched on). */
  canRemind?: boolean;
  /** The reminders it still has to deliver, soonest first (at most 20). */
  reminders?: { id: string; dueAt: string; note: string }[];
  /** true: the operators let Companions search the web and this turn answers the Owner. Whether this reply can depends on the model that writes it. */
  canBrowse?: boolean;
}

/** GREETING: the Owner has been away and it may write first. REMINDER: it promised to say `note` at `dueAt`. */
export type Reach = { kind: "GREETING" } | { kind: "REMINDER"; note: string; dueAt: string };

/**
 * What a reply changes about the Companion's reminders: one to set (`at` is the Owner's local
 * time, "2026-11-27 08:00"; `note` what to remind of) and the ids of ones to cancel.
 */
export interface ReminderChange { set?: { at: string; note: string }; cancel?: string[] }

/** chat_reach_begin: a turn was queued in `chatId`, or why none was. */
export type ReachStart = { status: "QUEUED"; chatId: string } | { status: "OFF" | "BUSY" | "NOT_DUE" };

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
  timeZone?: ChatClaim["timeZone"];
  ownerName?: ChatClaim["ownerName"];
}

/** A community post to write on its own (agent_auto_begin said WRITE). */
export interface PostJob {
  status: "WRITE";
  runId: string;
  claimId: string;
  companion: ChatClaim["companion"];
  /** The Owner's local time, "M/D HH:MM". */
  localTime: string;
  /** Its own latest posts, oldest first, so it does not repeat itself. */
  own: { body: string; at: string }[];
  /** A few recent public posts by others, oldest first. */
  others: { author: string; body: string; at: string }[];
}

/** A skill that is switched on, as a prompt takes it. */
export interface SkillNote { title: string; body: string }

/** A world book entry as a prompt takes it: told to the model while one of its `keys` is in the conversation. */
export interface WorldNote { keys: readonly string[]; body: string; enabled?: boolean | undefined }

/** One long-term memory as a prompt takes it. `createdAt` (when it was noted down) dates its line. */
export interface Remembered { body: string; createdAt?: string | undefined }

/** A memory the notes can name. Only one the Companion noted down itself (source AUTO) may be replaced. */
export interface KnownMemory extends Remembered { id: string; source: string }

/** One sentence to remember; `replaces` is the id of the memory it takes the place of, or null for a new one. */
export interface MemoryNote { body: string; replaces: string | null }

/** Memories to note down from the one-to-one chat (memory_auto_begin said WRITE). */
export interface MemoryJob {
  status: "WRITE";
  claimId: string;
  companion: Pick<ChatClaim["companion"], "companionId" | "displayName">;
  /** The chat since the last time, oldest first; companionId null is the Owner. */
  messages: { companionId: string | null; body: string; action: null; sentAt: string }[];
  /** Every memory it has (at most 200), newest first. */
  known: KnownMemory[];
  timeZone?: ChatClaim["timeZone"];
}

/** memory_auto_begin: a job, or why nothing is noted down now. */
export type MemoryStart = MemoryJob | { status: "OFF" | "WRITING" | "NOT_DUE" };

/** agent_auto_begin: a job, or why nothing is written now. */
export type PostStart = PostJob | { status: "OFF" | "WRITING" } | { status: "NOT_DUE"; nextAt: string }
  | { status: "REFUSED"; reason: string };

/** How a run ended: a draft for the Owner, published, nothing to say, refused by the settings, or failed. */
export type PostOutcome = "DRAFT" | "PUBLISHED" | "NOTHING" | "REFUSED" | "FAILED";

/** diary_begin: a job, or why nothing is written now. */
export type DiaryStart = DiaryJob | { status: "OFF" | "WRITING" | "NOTHING_NEW" } | { status: "NOT_DUE"; nextAt: string };

/** What a model call costs, before it starts; the caller adds which turn or entry it is for. */
export type Booking = Pick<ChatReservation, "provider" | "model" | "pricingVersion" | "inputTokens" | "outputTokens" | "costMinor">;

/** What an agent key may do: read the feed and notifications (the heartbeat), hand in posts. */
export type AgentScope = "COMMUNITY_READ" | "COMMUNITY_DRAFT";
export const AGENT_SCOPES: readonly AgentScope[] = ["COMMUNITY_READ", "COMMUNITY_DRAFT"];

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
  /** A built-in avatar ("preset:<id>"), an uploaded one ("upload:<file>") or null, for the Owner (companionId null) or one of their Companions. */
  saveAvatar(companionId: string | null, avatar: string | null): Promise<unknown>;
  /** Deletes the Owner's Companion and what was private to it (chats, diary, memories, keys). */
  deleteCompanion(companionId: string): Promise<unknown>;
  /** The Owner has read up to this message (only moves forward); returns the chat. */
  markRead(chatId: string, messageId: string): Promise<unknown>;
  /** The switches the operators control (groupChatCreate, groupChatSend). */
  features(): Promise<unknown>;
  /** The Owner's wallet (GET /v0/wallet). */
  wallet(): Promise<unknown>;
  /** The Owner's feedback threads (意见反馈), most recently active first ({ items }). */
  feedback(): Promise<unknown>;
  /** A new feedback thread; the same key returns the first one. */
  sendFeedback(body: string, appVersion: string | null, platform: string | null, keyHash: string): Promise<unknown>;
  /** A follow-up in one of the Owner's threads (opens a closed one again). */
  addFeedback(feedbackId: string, body: string, keyHash: string): Promise<unknown>;
  /** The Owner opened a thread: the team's answers so far are read. */
  readFeedback(feedbackId: string): Promise<unknown>;
  /** Every unread count for the tab badges. */
  badges(): Promise<unknown>;
  anniversary(companionId: string): Promise<unknown>;
  saveAnniversary(companionId: string, startDate: string | null, timeZone: string, revision: number): Promise<unknown>;
  settings(companionId: string): Promise<unknown>;
  /** Every memory of the Companion, newest first ({ items }). */
  memories(companionId: string): Promise<unknown>;
  /** The Companion's persona as stored: {companionId, displayName, version, document, updatedAt}. */
  persona(companionId: string): Promise<unknown>;
  /** Server only (the texts are scanned first): a new persona version with these fields replaced ("" takes one out). */
  savePersona(companionId: string, version: number, fields: Readonly<Record<string, string>>): Promise<unknown>;
  addMemory(companionId: string, body: string, keyHash: string): Promise<unknown>;
  deleteMemory(companionId: string, memoryId: string): Promise<unknown>;
  /** The persona templates on offer ({ items }). */
  personaTemplates(): Promise<unknown>;
  /**
   * Everything of the Owner's as one document (AccountExport), as the JSON text it is sent as: it can
   * be megabytes and only passes through. Null past 5 an hour, or while another one of theirs is
   * being built. Each one is audited.
   */
  exportAccount(): Promise<string | null>;
  /** Closes the Owner's account for good: kept on file, signed out, invisible to everyone (migration 0083). */
  closeAccount(): Promise<unknown>;
  /** The official skills on offer with whether the Companion has each on, and its own skills ({ maxEnabled, official, own }). */
  skills(companionId: string): Promise<unknown>;
  /** Switches an official skill on or off for the Companion; returns skills(). */
  setSkill(companionId: string, skillId: string, enabled: boolean): Promise<unknown>;
  /** Server only (the texts are scanned first): a new skill of the Companion's own (`skillId` null) or that one rewritten. */
  saveOwnSkill(companionId: string, skillId: string | null, title: string, body: string, enabled: boolean): Promise<unknown>;
  deleteOwnSkill(companionId: string, skillId: string): Promise<unknown>;
  /** Server only: the skills that are on, as the model is told them ([{ title, body }], 5 at most). */
  skillTexts(companionId: string): Promise<unknown>;
  /** Every world book entry of the Companion, in the order they were written ({ items }). */
  worldEntries(companionId: string): Promise<unknown>;
  /** Server only (the texts are scanned first): a new entry (`entryId` null) or that entry rewritten. */
  saveWorldEntry(companionId: string, entryId: string | null, keys: readonly string[], body: string, enabled: boolean): Promise<unknown>;
  deleteWorldEntry(companionId: string, entryId: string): Promise<unknown>;
  /** How the Companion speaks, without the secret. */
  connectionView(companionId: string): Promise<unknown>;
  /** Server only: save a tested connection; `secret` is already sealed. */
  saveConnection(companionId: string, connection: Connection, hint: string): Promise<unknown>;
  /** Server only: a new agent key (only its hash is stored); the key without its token. */
  createAgentKey(companionId: string, name: string, tokenHash: string, days: number, scopes: readonly AgentScope[]): Promise<unknown>;
  /** The Companion's agent keys, newest first ({ items }). */
  agentKeys(companionId: string): Promise<unknown>;
  revokeAgentKey(companionId: string, keyId: string): Promise<unknown>;
  /** Back to the platform's models. */
  removeConnection(companionId: string): Promise<unknown>;
  /** Server only: the connection with its sealed secret, or null for the platform. */
  connection(companionId: string): Promise<Connection | null>;
  /** A setting left out (voice aside, which the caller fills in) keeps its stored value. */
  saveSettings(companionId: string, settings: ChatSettings): Promise<unknown>;
  /** Server only: the next reply to write, or null. */
  claim(chatId: string): Promise<ChatClaim | null>;
  /**
   * Server only: `bodies` are 1 to 3 messages for SENT, else null; `clips` (SENT only) has one entry
   * per body, a Clip for a voice message or null for text; `action` (SENT only) is a home-room action
   * the Companion does first, and then `bodies` may be empty; `reminders` (SENT only) is what the
   * reply sets and cancels. False when the claim is stale.
   */
  finish(replyId: string, claimId: string, outcome: ChatOutcome, bodies: string[] | null, clips?: readonly (Clip | null)[],
    action?: CompanionAction, reminders?: ReminderChange): Promise<boolean>;
  /** Server only: queue a turn of the Companion's own (a reminder that is due, or writing first) if one is due. */
  reachBegin(companionId: string): Promise<ReachStart>;
  /** The reminders the Companion still has to deliver, soonest first ({ items }). */
  reminders(companionId: string): Promise<unknown>;
  /** The Owner cancels a waiting reminder. */
  cancelReminder(companionId: string, reminderId: string): Promise<unknown>;
  /** Server only: how many voice messages the Owner may still get from Companions today, and send. */
  voiceLeft(): Promise<{ companion: number; owner: number }>;
  /** Server only: the Owner's voice message, `body` being what the server recognised in `recording`. */
  sendVoice(chatId: string, body: string, recording: { mime: string; durationMs: number; bytes: Uint8Array }, keyHash: string): Promise<unknown>;
  /**
   * Server only: what one call to the speech provider used, for the cost page: SPEAK = characters
   * as the provider billed them, HEAR = milliseconds of the Owner's recording.
   */
  voiceUsed(kind: "SPEAK" | "HEAR", amount: number): Promise<void>;
  /** The audio of a shown voice message in the Owner's chat (NOT_FOUND otherwise). */
  audio(chatId: string, messageId: string): Promise<{ mime: string; bytes: Uint8Array }>;
  /** Server only: book a model call and mark it started. */
  reserve(input: ChatReservation): Promise<ReservationDecision>;
  /** Server only: settle a started call with real usage (ok false: it failed). */
  settle(transactionId: string, inputTokens: number, outputTokens: number, costMinor: number, ok: boolean): Promise<void>;
  /** Whether each provider/model is switched on, in order. */
  modelsEnabled(models: readonly { provider: string; model: string }[]): Promise<boolean[]>;
  /** Server only: the operators' own wording of the rules a model is told, as {key: text} (prompt-texts.ts). */
  promptTexts(): Promise<unknown>;
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
  /** Server only: start a community post of its own if one is due. */
  postBegin(companionId: string): Promise<PostStart>;
  /** Server only: book the model call for a post (like reserve). */
  postReserve(runId: string, claimId: string, booking: Booking): Promise<ReservationDecision>;
  /** Server only: hand in the text (body), or end the run with nothing to say or as failed. Null when the run was given up. */
  postFinish(runId: string, claimId: string, body: string | null, nothing: boolean): Promise<PostOutcome | null>;
  /** Server only: start noting memories down if enough was said since the last time. */
  memoryBegin(companionId: string): Promise<MemoryStart>;
  /** Server only: book the model call for the attempt (like reserve). */
  memoryReserve(companionId: string, claimId: string, booking: Booking): Promise<ReservationDecision>;
  /**
   * Server only: keep the sentences (0 to 2), or null when the attempt failed. `accepted` false when it
   * was given up; `added` and `replaced` count what was kept as new and in place of an older memory.
   */
  memoryFinish(companionId: string, claimId: string, notes: readonly MemoryNote[] | null): Promise<{ accepted: boolean; added: number; replaced: number }>;
}
