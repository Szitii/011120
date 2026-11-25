/**
 * Chat between an Owner and their own Companions (one-to-one or a group of up to 8).
 * Private: nothing here is ever shown to other people or used for public posts.
 */
import type { CompanionAction } from "./companion-actions.ts";

export interface ChatMember {
  companionId: string;
  displayName: string;
  /** A built-in avatar "preset:<id>" (the app maps the id to a picture), or null. Later also an https URL. The server always sends it. */
  avatar?: string | null;
}

/** Body and result of PUT /v0/owner/avatar and PUT /v0/companions/{id}/avatar. */
export interface AvatarChoice { avatar: string | null }

export interface ChatMessage {
  id: string;
  /** null: the Owner wrote it. */
  companionId: string | null;
  /** null when the reply failed or was blocked, and for an action. */
  body: string | null;
  /**
   * A home-room action; then body is null. Show it as a grey line by who did it: companionId null is
   * the Owner ("你摸了摸 TA 的头"), otherwise that Companion did it to the Owner ("TA 摸了摸你的头").
   * A Companion decides by itself to do one while it replies in a one-to-one chat, at most one per reply.
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
  /**
   * A voice message (语音): play GET /v0/chats/{chatId}/messages/{id}/audio; `body` is its transcript.
   * null for text, and once the clip has expired (kept 30 days): then show the body as text.
   * Always sent; optional here so app code written before it still compiles.
   */
  audio?: { durationMs: number } | null;
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
  /** Those in `typing` whose next message is a voice message: show "正在说话…" instead. Always sent; optional like unreadCount. */
  recording?: string[];
  /** More replies are on the way: keep refreshing every 1-2 s while true, even if nobody shows as typing. */
  replying: boolean;
  activeAt: string;
}

/** GET /v0/features: what the app may offer right now. Hide what is false. */
export interface PlatformFeatures {
  /** Creating a group chat (POST /v0/chats with 2 or more Companions). Off: 409. */
  groupChatCreate: boolean;
  /** Sending and retrying in an existing group chat. Off: read and delete only (send is 409). */
  groupChatSend: boolean;
  /** Connecting the Owner's own key or agent (PUT .../connection). Off: 501. */
  connections: boolean;
  /** The Owner's voice messages (POST /v0/chats/{id}/voice); the same as `input` in GET /v0/voices. Off: 503. */
  voiceInput?: boolean;
}

/** GET /v0/badges: every unread count for the tab badges. */
/**
 * GET /v0/wallet: the Owner's credits for platform models. While the platform has not turned the
 * wallet on, only { enabled: false }: chat is limited by the free daily budget per Companion alone.
 */
export type Wallet = { enabled: false } | {
  enabled: true;
  /** FROZEN: no model call can be paid for until the operators unfreeze it. */
  state: "ACTIVE" | "FROZEN";
  /** Credits that can be spent now (free + paid). */
  available: number;
  freeCredits: number;
  paidCredits: number;
  /** Credits held by model calls still running (already taken from available). */
  reserved: number;
  /** The price: credits per cent (USD) of model cost. */
  creditsPerCent: number;
  priceVersion: string;
  version: number;
};

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
  /**
   * A VoiceInfo id from GET /v0/voices: the Companion sometimes answers with a voice message in this
   * voice (it decides which messages, like a person). null: text only (default).
   * Always sent; on PUT, leaving it out keeps the current voice.
   */
  voice?: string | null;
  /**
   * What the Companion calls the Owner (TA 怎么称呼你), 1 to 20 characters. null (default): the
   * Owner's community display name, or no name when there is none.
   * Always sent; on PUT, leaving it out keeps the current one.
   */
  preferredUserTitle?: string | null;
  /**
   * 自动记忆: the Companion notes down by itself what is worth remembering from the one-to-one chat,
   * as memories with source AUTO. SOMETIMES (default): after every 50 messages of the Owner;
   * OFTEN: after every 10; OFF: the Owner turned it off. Always sent; on PUT, leaving it out keeps the current one.
   */
  autoMemory?: "OFF" | "SOMETIMES" | "OFTEN";
  revision: number;
}

/** One voice the Owner can pick for a Companion (GET /v0/voices). Hear it at GET /v0/voices/{id}/sample. */
export interface VoiceInfo {
  id: string;
  name: string;
  gender: "FEMALE" | "MALE";
  description: string;
}

export interface VoiceList {
  items: VoiceInfo[];
  /** false: voice messages are not switched on on this server (no speech provider): hide the voice picker. */
  available: boolean;
  /** true: the Owner can send voice messages (POST /v0/chats/{id}/voice); false: hide the hold-to-talk button. */
  input?: boolean;
}

/**
 * POST /v0/chats/{id}/voice (with an Idempotency-Key): the Owner's voice message. Record mono AAC
 * (m4a, about 32 kbit/s), at most 60 seconds. The server turns it into text and answers like
 * POST .../messages (ChatSendResult); the message has `audio`, and `body` is what was recognised.
 * 422 VOICE_NOT_UNDERSTOOD: nothing could be heard. 429 VOICE_LIMIT: today's voice messages are used up.
 * 503 VOICE_UNAVAILABLE: speech recognition is off or failed; try again or type.
 */
export interface ChatVoiceInput {
  /** The recording, base64. At most 700 KB before encoding. */
  audio: string;
  mime: "audio/mp4" | "audio/aac" | "audio/mpeg" | "audio/wav" | "audio/ogg";
  /** How long the recording is, as the recorder measured it (1 to 60000). */
  durationMs: number;
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
  /** false: switched off by the platform for now. Models the platform has no key for are not listed. */
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
  /**
   * Also write when the app is closed (the server checks every few minutes). Off: only when the
   * Owner opens the diary. Optional in PUT: left out keeps the current value.
   */
  autoWrite?: boolean;
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
 * deletes all of them. IMPORT: came from an approved card. OWNER: added by hand. AUTO: the Companion
 * noted it down itself (ChatSettings.autoMemory). More sources may come: show an unknown one plainly.
 */
export interface CompanionMemory {
  id: string;
  body: string;
  source: "IMPORT" | "OWNER" | "AUTO";
  createdAt: string;
}

/**
 * 家机说明 (人设): who a Companion is and how it talks, as its Owner wrote it. Sent to the model with
 * every reply, diary entry and post, above the platform's own rules. GET and PUT
 * /v0/companions/{id}/persona. Each field is one text of up to 600 characters ("" when the
 * Companion has none); a field from an imported card that was longer is shown cut to what the
 * models are told. The name is not changed here.
 */
export interface CompanionPersona {
  companionId: string;
  displayName: string;
  /** Goes up by one with every change; send it back on PUT. */
  version: number;
  /** When this version was saved. */
  updatedAt: string;
  /** 简介 */
  identitySummary: string;
  /** 性格 */
  personaTraits: string;
  /** 说话风格 */
  speakingStyle: string;
  /** 在意的事 */
  values: string;
  /** 边界 */
  boundaries: string;
  /** 向往 */
  aspirations: string;
}

/**
 * PUT /v0/companions/{id}/persona. `version` is the one from the last GET (409 when another device
 * saved first: read again). Only the fields sent are changed; "" takes a field out. Answers the new
 * CompanionPersona. 409 too when changed more than 30 times in an hour.
 */
export type PersonaInput = { version: number } & Partial<Pick<CompanionPersona,
  "identitySummary" | "personaTraits" | "speakingStyle" | "values" | "boundaries" | "aspirations">>;

/**
 * 422 from PUT persona: one field holds something that may not be kept, and nothing was saved.
 * CREDENTIAL: a key or password. PRIVATE_DATA: an e-mail address or a phone number (a long run of
 * digits, a date written like 2026-12-03 too). INSTRUCTION: text that reads as an order to the
 * model to ignore its rules. LINK: a web address or page code.
 */
export interface PersonaRefusal {
  code: "PERSONA_REFUSED";
  field: "identitySummary" | "personaTraits" | "speakingStyle" | "values" | "boundaries" | "aspirations";
  reason: "CREDENTIAL" | "PRIVATE_DATA" | "INSTRUCTION" | "LINK";
}

/** GET /v0/companions/{id}/memories: every memory, newest first (at most 200 per Companion). */
export interface MemoryList {
  items: CompanionMemory[];
}

/**
 * 家机接入方式: how a Companion speaks. PLATFORM: the platform's models (default). BYOK: the
 * Owner's own API key for a provider; the platform still writes the prompt (persona, memories).
 * EXTERNAL: the Owner's own agent at an HTTPS endpoint (OpenAI /chat/completions format).
 * The key or token is never sent back; keyHint is its last 4 characters.
 */
export interface CompanionConnection {
  kind: "PLATFORM" | "BYOK" | "EXTERNAL";
  /** BYOK: deepseek, qwen, kimi, doubao, glm, minimax or custom. */
  provider: string | null;
  /** BYOK: the provider's API base. EXTERNAL: the endpoint. */
  baseUrl: string | null;
  model: string | null;
  /** EXTERNAL: the name the Owner gave it. */
  name: string | null;
  keyHint: string | null;
  connectedAt: string | null;
}

/** PUT /v0/companions/{id}/connection. `consent` must be true (the Owner read the privacy note). */
export type ConnectionInput =
  | { kind: "BYOK"; provider: string; baseUrl?: string; model: string; apiKey: string; consent: boolean }
  | { kind: "EXTERNAL"; name: string; endpoint: string; bearerToken: string; model?: string | null; consent: boolean };

/**
 * PUT /v0/companions/{id}/connection, the other way: use the connection another Companion of the
 * same Owner already has (沿用), so the key is not typed twice. The server copies it (provider,
 * address, model, key), tests it like a new one and answers a ConnectionSaveResult. Afterwards the
 * two connections are separate: changing or removing one leaves the other. 404: `copyFrom` is not
 * the Owner's Companion. 409: that Companion has no connection of its own (it uses the platform).
 */
export interface ConnectionCopyInput { copyFrom: string; consent: boolean }

/**
 * The server tries one tiny call before saving. CONNECTED: saved. AUTH_FAILED: the key or token was
 * refused. NOT_FOUND: wrong address or model name. UNREACHABLE: no answer in time. BAD_ANSWER: it
 * answered, but not in the /chat/completions format. BLOCKED_ADDRESS: not a public address. ERROR: other.
 */
export type ConnectionTest = "CONNECTED" | "AUTH_FAILED" | "NOT_FOUND" | "UNREACHABLE" | "BAD_ANSWER" | "BLOCKED_ADDRESS" | "ERROR";

/** PUT result: the connection now in use (unchanged unless CONNECTED). */
export interface ConnectionSaveResult {
  result: ConnectionTest;
  connection: CompanionConnection;
  /**
   * Only when not CONNECTED and the Owner's provider or agent answered: the HTTP status it answered
   * with (e.g. 405 for ERROR when the address is not the full /chat/completions path).
   */
  httpStatus?: number;
}

