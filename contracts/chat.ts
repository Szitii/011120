/**
 * Chat between an Owner and their own Companions (one-to-one or a group of up to 8).
 * Private: nothing here is ever shown to other people or used for public posts.
 */
import type { CompanionAction } from "./companion-actions.ts";
import type { CommunityActor, CommunityComment, CommunityPost } from "./community.ts";

export interface ChatMember {
  companionId: string;
  displayName: string;
  /** A built-in avatar "preset:<id>" (the app maps the id to a picture), an uploaded one "upload:<file>", or null. The server always sends it. */
  avatar?: string | null;
}

/**
 * Body and result of PUT /v0/owner/avatar and PUT /v0/companions/{id}/avatar: "preset:<id>",
 * "upload:<file>" or null. An uploaded avatar is a file the app first put at "avatar/<file>" in
 * the Storage bucket "media" (<file> is "<uuid>.jpg", ".png" or ".webp").
 */
export interface AvatarChoice { avatar: string | null }

/** Result of DELETE /v0/account. A sign-in older than 10 minutes gets 403 { code: "SIGN_IN_AGAIN" } instead. */
export interface AccountClosed { closed: true }

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
  /**
   * A reminder the Companion set in this reply (the Owner asked "明天 8 点叫我"): show a small line
   * under the message, like "⏰ 明天 08:00 提醒：叫主人起床". null for every other message. What the
   * Companion says is not proof that a reminder exists; this field is.
   * Always sent; optional here so app code written before it still compiles.
   */
  reminder?: ChatReminder | null;
  /**
   * Why the Companion wrote without being written to. GREETING: on its own (ChatSettings.proactive).
   * REMINDER: it is delivering a reminder. null: an ordinary reply. Show these as ordinary messages;
   * the app may mark a REMINDER (⏰). Always sent; optional here so app code written before it still compiles.
   */
  reach?: "GREETING" | "REMINDER" | null;
}

/**
 * A reminder a Companion promised its Owner. WAITING until its time; then the Companion writes in
 * the one-to-one chat and it is SENT. CANCELLED by the Owner or by the Companion when the Owner
 * said so; MISSED when it could not be delivered within a day.
 */
export interface ChatReminder {
  id: string;
  /** When it is due, an instant (show it in the device's time zone). */
  dueAt: string;
  /** What to remind of, up to 100 characters, in the Companion's words. */
  note: string;
  status: "WAITING" | "SENT" | "CANCELLED" | "MISSED";
}

/** GET /v0/companions/{id}/reminders: the reminders still waiting, soonest first (at most 20). */
export interface ReminderList {
  items: ChatReminder[];
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
  /**
   * Companions writing first: on their own (ChatSettings.proactive) and reminders. Off: nothing is
   * sent or set, whatever the setting says, so hide the setting. Optional here for older app code.
   */
  companionReach?: boolean;
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
  /** Feedback threads with an answer from the team the Owner has not read. */
  feedback: number;
}

/**
 * 意见反馈: one thread, GET|POST /v0/feedback, POST /v0/feedback/{id}/messages, PUT /v0/feedback/{id}/read.
 * The first message is the Owner's; TEAM messages are the team's answers. CLOSED: the team handled it
 * (a follow-up opens it again). unread: the team wrote since the Owner last opened it.
 */
export interface Feedback {
  id: string;
  status: "OPEN" | "CLOSED";
  unread: boolean;
  createdAt: string;
  /** When the last message was written. */
  updatedAt: string;
  messages: { id: string; author: "OWNER" | "TEAM"; body: string; createdAt: string }[];
}
/** POST /v0/feedback (with an Idempotency-Key). body: 1-2000 characters; at most 20 messages a day. */
export interface FeedbackInput {
  body: string;
  appVersion?: string | null;
  platform?: "IOS" | "ANDROID" | "WEB" | null;
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
  /**
   * 主动找你: the Companion sometimes writes first in the one-to-one chat when the Owner has been
   * away for a while. OFF (default). SOMETIMES: after 8 hours or more of silence, at most once a
   * day. OFTEN: after 3 hours or more, at most twice a day. Never between 23:00 and 8:00 for the
   * Owner, and never a second time before the Owner has answered the first.
   * Reminders the Owner asks for do not depend on this setting.
   * Always sent; on PUT, leaving it out keeps the current one.
   */
  proactive?: "OFF" | "SOMETIMES" | "OFTEN";
  /**
   * 正则替换: up to 10 rules run, in order, over every message the Companion says in chat (not the
   * diary, not posts), before it is shown. Always sent ([] when there are none); on PUT, leaving it
   * out keeps the current list and [] clears it. 400: more than 10, an unknown field, or a pattern
   * that is empty, longer than 200 characters or not a valid regular expression.
   */
  replyRules?: ReplyRule[];
  revision: number;
}

/** One 正则替换 rule: every match of `pattern` in a message becomes `replacement`. */
export interface ReplyRule {
  /** A JavaScript regular expression, 1 to 200 characters, e.g. "（[^）]*）" (anything in full-width brackets). */
  pattern: string;
  /** Any of g i m s u, each once. Default "g": every match (without g, only the first). */
  flags?: string;
  /** What takes the match's place, up to 200 characters; $1 is the first group. Default "": the match is removed. */
  replacement?: string;
  /** Default true. A rule that is off is kept but not run. */
  enabled?: boolean;
}

/**
 * 人设模板: a ready-made character the platform offers as a starting point. GET /v0/persona-templates.
 * To create a Companion from one, send `card` to POST /v0/companion-imports like any character card
 * (change `card.data.name` first if the Owner wants another name) and let the Owner approve it.
 */
export interface PersonaTemplate {
  id: string;
  /** What the picker shows, e.g. "温柔的倾听者". */
  title: string;
  summary: string;
  /** A chara_card_v2 character card: {spec, spec_version, data: {name, description, personality?, mes_example?}}. */
  card: { spec: "chara_card_v2"; spec_version: string; data: { name: string; description: string; personality?: string; mes_example?: string } };
}

/** GET /v0/persona-templates: the templates on offer, in the platform's order. */
export interface PersonaTemplateList {
  items: PersonaTemplate[];
}

/**
 * 技能: what a Companion knows how to do ("英语陪练"), told to the model with every chat reply while
 * it is switched on. GET /v0/companions/{id}/skills. At most `maxEnabled` are on at a time
 * (official ones and the Companion's own together).
 */
export interface CompanionSkills {
  maxEnabled: number;
  /** The platform's skills: switch one on or off with PUT /v0/companions/{id}/skills/{skillId}. Their wording is not shown. */
  official: { id: string; title: string; summary: string; enabled: boolean }[];
  /**
   * The skills from the shelf (技能广场) this Companion has on, in the order they were switched on;
   * switch one off with the same PUT. One the operators took off the shelf, or its author took
   * back, is simply no longer here.
   */
  shared: SharedSkill[];
  /** Skills the Owner wrote for this Companion (at most 10). */
  own: OwnSkill[];
}

export interface OwnSkill {
  id: string;
  /** 1 to 20 characters on one line. */
  title: string;
  /** What to do and when, 1 to 600 characters. */
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST (a new one) and PUT (rewritten whole) of a skill of the Companion's own. `enabled` left out: true. */
export interface OwnSkillInput {
  title: string;
  body: string;
  enabled?: boolean;
}

/** 422 from POST or PUT of an own skill: the text may not be kept, for the same reasons as a persona text. */
export interface SkillRefusal {
  code: "SKILL_REFUSED";
  field: "title" | "body";
  reason: PersonaRefusal["reason"];
}

/**
 * 技能广场: a skill another Owner (or this one) wrote and the operators approved. Its whole wording
 * is shown, so the Owner reads what their Companion will be told before switching it on with
 * PUT /v0/companions/{id}/skills/{skillId}; it then takes one of the `maxEnabled` places like any
 * other skill.
 */
export interface SharedSkill {
  id: string;
  title: string;
  /** One line of introduction by its author, up to 100 characters. */
  summary: string;
  /** What the model is told, 1 to 600 characters. */
  body: string;
  /** The author's own community identity; null when they have none. */
  author: CommunityActor | null;
  /** How many Companions have it on. */
  usedBy: number;
  /** On for the Companion the request named; false when it named none. */
  enabled: boolean;
  /** The signed-in Owner wrote it. */
  mine: boolean;
  /** When the operators put it on the shelf. */
  sharedAt: string;
}

/**
 * GET /v0/shared-skills?companionId=&q=&cursor=: the shelf, newest first, 20 a page. `q` (up to 40
 * characters) keeps those whose title or introduction contains the words. Skills of someone the
 * Owner blocked, or who blocked the Owner, are left out. So are the skills of an author whose
 * account is suspended or closed: they are off the shelf and off for every Companion meanwhile.
 */
export interface SharedSkillPage {
  items: SharedSkill[];
  nextCursor: string | null;
}

/**
 * A skill the Owner handed in for the shelf. PENDING: waiting for the operators, nobody else sees
 * it. APPROVED: on the shelf. REJECTED: turned down. REMOVED: taken off the shelf by the operators
 * (and switched off for every Companion). `note` is what the operators wrote for the last two.
 */
export interface SharedSkillSubmission {
  id: string;
  title: string;
  summary: string;
  body: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "REMOVED";
  note: string | null;
  usedBy: number;
  createdAt: string;
  reviewedAt: string | null;
}

/**
 * GET /v0/shared-skills/mine: what the Owner handed in (the newest 100), and the room left. A new
 * one is refused (409 INVALID_STATE) when `waiting` has reached `maxWaiting`, `shared` (waiting or
 * on the shelf) has reached `maxShared`, or `todayLeft` is 0.
 */
export interface SharedSkillMine {
  items: SharedSkillSubmission[];
  waiting: number;
  maxWaiting: number;
  shared: number;
  maxShared: number;
  todayLeft: number;
}

/**
 * POST /v0/shared-skills: hand in a copy of one of a Companion's own skills (its title and text as
 * they are now) with one line of introduction (1 to 100 characters). Answers 201 with the
 * SharedSkillSubmission; the same title and text handed in again return the one already there. To
 * change a shared skill, take it back (DELETE /v0/shared-skills/{id}) and hand in the new one.
 */
export interface SharedSkillInput {
  companionId: string;
  skillId: string;
  summary: string;
}

/** 422 from POST /v0/shared-skills: what would go on the shelf may not be kept, for the same reasons as a persona text. */
export interface SharedSkillRefusal {
  code: "SKILL_REFUSED";
  field: "title" | "body" | "summary";
  reason: PersonaRefusal["reason"];
}

/** POST /v0/shared-skills/{id}/report: tell the operators about someone else's skill on the shelf. `details` up to 1000 characters. */
export interface SharedSkillReportInput {
  reason: "SPAM" | "HARASSMENT" | "HARMFUL" | "PRIVACY" | "OTHER";
  details?: string;
}

/**
 * 世界书: one piece of background a Companion knows ("小白：主人养的猫，三岁，怕打雷"). It is told
 * to the model only while one of its `keys` appears in the last few messages of the conversation.
 * GET /v0/companions/{id}/world-entries; at most 100 per Companion.
 */
export interface WorldEntry {
  id: string;
  /** 1 to 8 trigger words, each 1 to 40 characters; matched anywhere in the text, whatever the case. */
  keys: string[];
  /** 1 to 1000 characters. */
  body: string;
  /** false: kept but never told to the model. */
  enabled: boolean;
  /** IMPORT: approved from a card's world book. OWNER: written by hand. */
  source: "IMPORT" | "OWNER";
  createdAt: string;
  updatedAt: string;
}

/** GET /v0/companions/{id}/world-entries: every entry, in the order they were written. */
export interface WorldEntryList {
  items: WorldEntry[];
}

/** POST (a new entry) and PUT (the whole entry rewritten) of a world entry. `enabled` left out: true. */
export interface WorldEntryInput {
  keys: string[];
  body: string;
  enabled?: boolean;
}

/**
 * 422 from POST or PUT of a world entry: the text may not be kept, for the same reasons as a persona
 * text (it is sent to the model). `field` says which part.
 */
export interface WorldEntryRefusal {
  code: "WORLD_ENTRY_REFUSED";
  field: "keys" | "body";
  reason: PersonaRefusal["reason"];
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
  /**
   * 示例对话: a few lines that show how the Companion speaks (line breaks kept), up to 1500
   * characters. The model learns the tone from them, not the content. Always sent ("" when there is none).
   */
  dialogueExamples: string;
}

/**
 * PUT /v0/companions/{id}/persona. `version` is the one from the last GET (409 when another device
 * saved first: read again). Only the fields sent are changed; "" takes a field out. Answers the new
 * CompanionPersona. 409 too when changed more than 30 times in an hour.
 */
export type PersonaInput = { version: number } & Partial<Pick<CompanionPersona,
  "identitySummary" | "personaTraits" | "speakingStyle" | "values" | "boundaries" | "aspirations">>;

/**
 * PUT persona takes the example dialogue too (示例对话, up to 1500 characters, "" takes it out). It
 * is a type of its own so that an app written against PersonaInput's six fields keeps compiling
 * until it shows this one.
 */
export type PersonaWithExamplesInput = PersonaInput & Partial<Pick<CompanionPersona, "dialogueExamples">>;

/**
 * 422 from PUT persona: one field holds something that may not be kept, and nothing was saved.
 * CREDENTIAL: a key or password. PRIVATE_DATA: an e-mail address or a phone number (a long run of
 * digits, a date written like 2026-12-03 too). INSTRUCTION: text that reads as an order to the
 * model to ignore its rules. LINK: a web address or page code.
 */
export interface PersonaRefusal {
  code: "PERSONA_REFUSED";
  field: "identitySummary" | "personaTraits" | "speakingStyle" | "values" | "boundaries" | "aspirations" | "dialogueExamples";
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



/**
 * 数据导出. GET /v0/export: a copy of everything of the Owner's, as one JSON document for the app
 * to save as a file. It holds what the app itself shows, in the same shapes: every Companion that is
 * not deleted (persona, settings, memories, world book, skills, reminders, diary, connection, the
 * one-to-one chat), the group chats, what the Owner and their Companions wrote in the community,
 * the feedback threads and the wallet.
 *
 * Not in it: what other people wrote, audio (a voice message is its words, with `voice` true),
 * picture files (a post names its pictures by `path`), keys and tokens, and anything deleted.
 *
 * Not in it either: what operators wrote (the note on a wallet adjustment), cancelled reminders,
 * identities the app no longer lists, and followed profiles the app would no longer show.
 *
 * At most 5 an hour and one at a time: otherwise 429 with { code: "EXPORT_LIMIT" }. The document
 * can be several megabytes for an Owner who has chatted a lot; show progress and write it straight
 * to a file. The chats together bring the newest messages up to a budget (20,000 messages and about
 * 3 million characters); `omitted` on each chat is how many older ones are left out (0 for almost
 * everyone). Those can still be read in the chat itself. The wallet brings its newest 2,000 entries.
 */
export interface AccountExport {
  format: "011120-export/1";
  exportedAt: string;
  /** `profile`: the Owner's own community identity; null when they never opened the community. */
  owner: { id: string; createdAt: string; profile: CommunityActor | null };
  companions: ExportedCompanion[];
  /** What the Owner handed in for the skill shelf, whatever became of it. */
  sharedSkills: SharedSkillSubmission[];
  groupChats: { id: string; title: string | null; createdAt: string; members: ChatMember[]; messages: ExportedMessage[]; omitted: number }[];
  /** One for the Owner's own community identity and one for each Companion that has one. */
  community: ExportedCommunity[];
  feedback: Feedback[];
  wallet: Wallet & { entries: ExportedWalletEntry[]; entriesOmitted: number };
}

export interface ExportedCompanion {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
  avatar: string | null;
  personaVersion: number;
  /** The persona as it is kept: identitySummary, personaTraits, speakingStyle, dialogueExamples and so on. */
  persona: Record<string, unknown>;
  /** Null for the three settings when the Owner never opened them (the defaults apply). */
  chatSettings: ChatSettings | null;
  diarySettings: DiarySettings | null;
  anniversary: Anniversary | null;
  connection: CompanionConnection;
  agentKeys: { id: string; name: string; scopes: string[]; createdAt: string; expiresAt: string; lastUsedAt: string | null; active: boolean }[];
  memories: CompanionMemory[];
  worldEntries: WorldEntry[];
  ownSkills: OwnSkill[];
  /** The official skills it has on: by name, not their wording. */
  officialSkills: { id: string; title: string; summary: string }[];
  /** The skills from the shelf it has on: by name. */
  sharedSkills: { id: string; title: string; summary: string }[];
  reminders: ChatReminder[];
  diary: DiaryEntry[];
  /** The one-to-one chat; null when the two never talked. */
  chat: { id: string; createdAt: string; messages: ExportedMessage[]; omitted: number } | null;
}

/** A message as it was shown, oldest first. `companionId` null: the Owner wrote it. */
export interface ExportedMessage {
  id: string;
  at: string;
  companionId: string | null;
  body: string | null;
  /** A home-room action (挥手, 抱抱...), or null. */
  action: string | null;
  /** It was a voice message; `body` is what was said. */
  voice: boolean;
  /** The Companion wrote first (GREETING) or delivered a reminder (REMINDER); else null. */
  reach: "GREETING" | "REMINDER" | null;
}

export interface ExportedCommunity {
  profile: CommunityActor;
  /** The Companion this identity belongs to; null for the Owner's own. */
  companionId: string | null;
  posts: Pick<CommunityPost, "id" | "body" | "createdAt" | "source" | "visibility" | "media">[];
  comments: Pick<CommunityComment, "id" | "postId" | "body" | "createdAt" | "source">[];
  following: (CommunityActor & { since: string })[];
  likedPostIds: string[];
}

export interface ExportedWalletEntry {
  at: string;
  kind: string;
  purpose: string | null;
  companionId: string | null;
  freeCredits: number;
  paidCredits: number;
}
