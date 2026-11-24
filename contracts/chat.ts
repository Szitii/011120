/**
 * Chat between an Owner and their own Companions (one-to-one or a group of up to 8).
 * Private: nothing here is ever shown to other people or used for public posts.
 */
import type { CompanionAction } from "./companion-actions.ts";

export interface ChatMember {
  companionId: string;
  displayName: string;
}

export interface ChatMessage {
  id: string;
  /** null: the Owner wrote it. */
  companionId: string | null;
  /** null when the reply failed or was blocked, and for an action. */
  body: string | null;
  /**
   * Set when the Owner did a home-room action (show it as a grey line, e.g. "你摸了摸 TA 的头"); then body is null.
   * The server always sends it (null for ordinary messages); optional here so app code written before it still compiles.
   */
  action?: CompanionAction | null;
  /** Companions the Owner @mentioned. */
  mentions: string[];
  status: "SENT" | "FAILED" | "BLOCKED";
  /**
   * FAILED only. UNAVAILABLE: no model can answer yet ("coming soon"). DISABLED: the platform switched
   * its models off for now. QUOTA: today's free replies are used up. ERROR: something went wrong.
   */
  failure: "UNAVAILABLE" | "DISABLED" | "QUOTA" | "ERROR" | null;
  /** true when POST .../retry may be used (failure ERROR). A BLOCKED reply is final. */
  retryable: boolean;
  sentAt: string;
}

export interface Chat {
  id: string;
  /** Group name chosen by the Owner; always null for a one-to-one chat. */
  title: string | null;
  /** true for the one-to-one chat with a single Companion. */
  direct: boolean;
  members: ChatMember[];
  lastMessage: ChatMessage | null;
  /**
   * Companion messages shown after the Owner's read position (PUT /v0/chats/{id}/read).
   * The server always sends it; optional here so app code written before it still compiles.
   */
  unreadCount?: number;
  /** The last message the Owner read; null before the first. Always sent; optional like unreadCount. */
  readUpTo?: string | null;
  /** Companions to show as "typing…" right now. */
  typing: string[];
  /** More replies are on the way: keep refreshing every 1-2 s while true, even if nobody shows as typing. */
  replying: boolean;
  activeAt: string;
}

/** GET /v0/badges: every unread count for the tab badges. */
export interface Badges {
  /** Unread Companion messages over every chat. */
  chats: number;
  /** Unread items of GET /v0/life-event-inbox. */
  ownerInbox: number;
  /** Unread community notifications for each identity the Owner can act as (the Owner first). */
  community: { actorKind: "OWNER" | "COMPANION"; actorId: string; unread: number }[];
}

/**
 * 相伴起始日: the calendar day (in timeZone) the Owner and this Companion count from; null when not set.
 * PUT sends startDate (or null to clear), timeZone and the revision last read; a stale revision is a 409.
 */
export interface Anniversary {
  companionId: string;
  startDate: string | null;
  timeZone: string;
  revision: number;
  updatedAt: string;
}

export interface ChatPage {
  chat: Chat;
  /** Newest first. */
  items: ChatMessage[];
  /** Pass as ?cursor= to load older messages; null when there are no more. */
  nextCursor: string | null;
}

export interface ChatSendResult {
  message: ChatMessage;
  typing: string[];
  replying: boolean;
}

/** POST /v0/companions/{id}/actions: the action, recorded in the one-to-one chat `chatId`. */
export interface CompanionActionResult extends ChatSendResult {
  chatId: string;
}

/** How a Companion takes part in group chats. One-to-one chats always answer. */
export interface ChatSettings {
  /** 群聊活跃度. QUIET: only when @mentioned. NORMAL: when @mentioned or the topic concerns it. ACTIVE: every Owner message. */
  groupActivity: "QUIET" | "NORMAL" | "ACTIVE";
  /** 家机互动倾向: how often it joins in when other Companions talk; at most 0 / 1 / 2 / 4 times per Owner message. */
  companionInteraction: "NONE" | "RARE" | "NORMAL" | "LIVELY";
  /** A ChatModelInfo id from GET /v0/chat-models; null = the platform default. */
  model: string | null;
  revision: number;
}

/** One model the Owner can pick (GET /v0/chat-models). */
export interface ChatModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: "ECONOMY" | "STANDARD" | "PREMIUM";
  /** USD per million tokens, for showing the relative cost. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** false: listed but not usable now (no key configured or switched off by the platform). */
  available: boolean;
}

export interface ChatModelList {
  items: ChatModelInfo[];
  /** What a Companion with model null uses; null when no model is usable. */
  defaultModel: string | null;
}

/**
 * 家机日记: how often a Companion writes. Entries are written when the Owner opens the diary
 * (POST /v0/companions/{id}/diary), if one is due and something happened since the last one.
 * OFF: never. RARE: about every 3 days. DAILY: about once a day (default). OFTEN: up to every 6 hours.
 */
export interface DiarySettings {
  frequency: "OFF" | "RARE" | "DAILY" | "OFTEN";
  revision: number;
}

/** One diary entry, written by the Companion in the first person. Only its Owner sees it. */
export interface DiaryEntry {
  id: string;
  companionId: string;
  body: string;
  writtenAt: string;
}

/** GET /v0/companions/{id}/diary */
export interface DiaryPage {
  /** Newest first, 20 per page. */
  items: DiaryEntry[];
  /** Pass as ?cursor= for older entries; null when there are no more. */
  nextCursor: string | null;
  /** An entry is being written right now (another device opened the diary). */
  writing: boolean;
}

/**
 * POST /v0/companions/{id}/diary: "write one if it is time".
 * WRITTEN: `entry` is new. OFF: the diary is turned off. WRITING: one is being written already (GET again in a few seconds).
 * NOT_DUE: too soon; `nextAt` is the earliest time. NOTHING_NEW: nothing happened since the last entry.
 * FAILED: see `failure` (UNAVAILABLE no model yet, DISABLED switched off, QUOTA today's free calls used up,
 * BLOCKED stopped by the safety scan, ERROR something went wrong); it may try again 10 minutes later.
 */
export interface DiaryWriteResult {
  status: "WRITTEN" | "OFF" | "WRITING" | "NOT_DUE" | "NOTHING_NEW" | "FAILED";
  entry: DiaryEntry | null;
  nextAt: string | null;
  failure: "UNAVAILABLE" | "DISABLED" | "QUOTA" | "BLOCKED" | "ERROR" | null;
}

/**
 * 长期记忆: one thing a Companion remembers, used when it chats and writes its diary. Only the Owner
 * adds memories (by hand, or by approving them one by one when importing a card), and sees and
 * deletes all of them. IMPORT: came from an approved card. OWNER: added by hand.
 */
export interface CompanionMemory {
  id: string;
  body: string;
  source: "IMPORT" | "OWNER";
  createdAt: string;
}

/** GET /v0/companions/{id}/memories: every memory, newest first (at most 200 per Companion). */
export interface MemoryList {
  items: CompanionMemory[];
}
