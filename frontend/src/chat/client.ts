import type {
  AvatarChoice,
  Anniversary, Badges, CompanionMemory, CompanionPersona, MemoryList,
  CompanionConnection, ConnectionCopyInput, ConnectionInput, ConnectionSaveResult,
  Chat,
  ChatMessage,
  ChatModelList,
  ChatPage,
  ChatSendResult,
  ChatSettings,
  ChatVoiceInput,
  Feedback,
  FeedbackInput,
  PersonaWithExamplesInput,
  CompanionSkills, OwnSkill, OwnSkillInput, WorldEntry, WorldEntryInput, WorldEntryList,
  PlatformFeatures,
  VoiceList,
  Wallet,
  CompanionActionResult,
} from "../../../contracts/chat.ts";

import type { CompanionAction } from "../../../contracts/companion-actions.ts";

export interface AudioClip {
  bytes: ArrayBuffer;
  mime: ChatVoiceInput["mime"];
}

interface ChatRetryResult {
  typing: string[];
  replying: boolean;
}

export type AgentScope = "COMMUNITY_READ" | "COMMUNITY_DRAFT";

export interface AgentKey {
  id: string;
  companionId: string;
  name: string;
  scopes: AgentScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  active: boolean;
}

export interface ChatClient {
  listAgentKeys?(id: string): Promise<{ items: AgentKey[] }>;
  createAgentKey?(id: string, name: string, scopes?: AgentScope[]): Promise<AgentKey & { token: string }>;
  revokeAgentKey?(id: string, keyId: string): Promise<AgentKey>;
  listVoices?(): Promise<VoiceList>;
  voiceSample?(voiceId: string): Promise<AudioClip>;
  messageAudio?(chatId: string, messageId: string): Promise<AudioClip>;
  sendVoice?(chatId: string, input: ChatVoiceInput, key: string): Promise<ChatSendResult>;
  wallet?(): Promise<Wallet>;
  features?(): Promise<PlatformFeatures>;
  badges?(): Promise<Badges>;
  listFeedback?(): Promise<{ items: Feedback[] }>;
  createFeedback?(input: FeedbackInput, key: string): Promise<Feedback>;
  replyFeedback?(id: string, body: string, key: string): Promise<Feedback>;
  markFeedbackRead?(id: string): Promise<Feedback>;
  markRead?(chatId: string, messageId: string): Promise<Chat>;
  getAnniversary?(id: string): Promise<Anniversary>;
  saveAnniversary?(id: string, value: Pick<Anniversary, "startDate" | "timeZone" | "revision">): Promise<Anniversary>;
  listMemories?(id: string): Promise<MemoryList>;
  addMemory?(id: string, body: string, key: string): Promise<CompanionMemory>;
  deleteMemory?(id: string, memoryId: string): Promise<unknown>;
  deleteCompanion?(id: string): Promise<{ deleted: true }>;
  saveAvatar?(id: string | null, avatar: string | null): Promise<AvatarChoice>;
  getConnection?(id: string): Promise<CompanionConnection>;
  saveConnection?(id: string, input: ConnectionInput | ConnectionCopyInput): Promise<ConnectionSaveResult>;
  removeConnection?(id: string): Promise<CompanionConnection>;
  getPersona?(id: string): Promise<CompanionPersona>;
  savePersona?(id: string, input: PersonaWithExamplesInput): Promise<CompanionPersona>;
  listWorldEntries?(id: string): Promise<WorldEntryList>;
  saveWorldEntry?(id: string, input: WorldEntryInput, entryId?: string): Promise<WorldEntry>;
  deleteWorldEntry?(id: string, entryId: string): Promise<{ deleted: true }>;
  listSkills?(id: string): Promise<CompanionSkills>;
  toggleOfficialSkill?(id: string, skillId: string, enabled: boolean): Promise<CompanionSkills>;
  saveOwnSkill?(id: string, input: OwnSkillInput, skillId?: string): Promise<OwnSkill>;
  deleteOwnSkill?(id: string, skillId: string): Promise<{ deleted: true }>;
  listChats(): Promise<{ items: Chat[] }>;
  openChat(companionIds: string[], title?: string, key?: string): Promise<Chat>;
  getChat(chatId: string, cursor?: string): Promise<ChatPage>;
  deleteChat(chatId: string): Promise<{ deleted: true }>;
  sendMessage(
    chatId: string,
    body: string,
    mentions?: string[],
    idempotencyKey?: string,
  ): Promise<ChatSendResult>;
  retryMessage(chatId: string, messageId: string): Promise<ChatRetryResult>;
  getChatSettings(companionId: string): Promise<ChatSettings>;
  updateChatSettings(companionId: string, settings: ChatSettings): Promise<ChatSettings>;
  sendAction(companionId: string, action: CompanionAction, key: string): Promise<CompanionActionResult>;
  listModels?(): Promise<ChatModelList>;
}

type SendFn = <T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) => Promise<T>;

// The API lists only visible messages, newest first. Any of them can advance the read position.
export function chatReadTarget(chat: Pick<Chat, "unreadCount" | "readUpTo"> | null, latest?: Pick<ChatMessage, "id">): string | undefined {
  if (!chat?.unreadCount) return undefined;
  const latestId = latest?.id;
  return latestId === chat.readUpTo ? undefined : latestId;
}

export function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createChatClient(send: SendFn, getAudio?: (path: string) => Promise<AudioClip>): ChatClient {
  const companion = (id: string) => `/v0/companions/${encodeURIComponent(id)}`;
  return {
    deleteCompanion: id => send("DELETE", companion(id)),
    saveAvatar: (id, avatar) => send("PUT", id === null ? "/v0/owner/avatar" : `${companion(id)}/avatar`, { avatar }),
    listAgentKeys: id => send("GET", `${companion(id)}/agent-keys`),
    createAgentKey: (id, name, scopes) => send("POST", `${companion(id)}/agent-keys`, { name, ...(scopes ? { scopes } : {}) }),
    revokeAgentKey: (id, keyId) => send("DELETE", `${companion(id)}/agent-keys/${encodeURIComponent(keyId)}`),
    listVoices: () => send("GET", "/v0/voices"),
    voiceSample: getAudio ? id => getAudio(`/v0/voices/${encodeURIComponent(id)}/sample`) : undefined,
    messageAudio: getAudio ? (id, messageId) =>
      getAudio(`/v0/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/audio`) : undefined,
    sendVoice: (chatId, input, key) => send("POST", `/v0/chats/${encodeURIComponent(chatId)}/voice`, input, key),
    async features() {
      const response = await send<Partial<PlatformFeatures> | null>("GET", "/v0/features");
      return {
        groupChatCreate: response?.groupChatCreate === true,
        groupChatSend: response?.groupChatSend === true,
        connections: response?.connections === true,
      };
    },
    wallet: () => send("GET", "/v0/wallet"),
    badges: () => send("GET", "/v0/badges"),
    listFeedback: () => send("GET", "/v0/feedback"),
    createFeedback: (input, key) => send("POST", "/v0/feedback", input, key),
    replyFeedback: (id, body, key) => send("POST", `/v0/feedback/${encodeURIComponent(id)}/messages`, { body }, key),
    markFeedbackRead: id => send("PUT", `/v0/feedback/${encodeURIComponent(id)}/read`),
    markRead: (id, messageId) => send("PUT", `/v0/chats/${encodeURIComponent(id)}/read`, { messageId }),
    getAnniversary: id => send("GET", `${companion(id)}/anniversary`),
    saveAnniversary: (id, value) => send("PUT", `${companion(id)}/anniversary`, value),
    listMemories: id => send("GET", `${companion(id)}/memories`),
    addMemory: (id, body, key) => send("POST", `${companion(id)}/memories`, { body }, key),
    deleteMemory: (id, memoryId) => send("DELETE", `${companion(id)}/memories/${encodeURIComponent(memoryId)}`),
    getConnection: id => send("GET", `${companion(id)}/connection`),
    saveConnection: (id, input) => send("PUT", `${companion(id)}/connection`, input),
    removeConnection: id => send("DELETE", `${companion(id)}/connection`),
    getPersona: id => send("GET", `${companion(id)}/persona`),
    savePersona: (id, input) => send("PUT", `${companion(id)}/persona`, input),
    listWorldEntries: id => send("GET", `${companion(id)}/world-entries`),
    saveWorldEntry: (id, input, entryId) => entryId
      ? send("PUT", `${companion(id)}/world-entries/${encodeURIComponent(entryId)}`, input)
      : send("POST", `${companion(id)}/world-entries`, input),
    deleteWorldEntry: (id, entryId) => send("DELETE", `${companion(id)}/world-entries/${encodeURIComponent(entryId)}`),
    listSkills: id => send("GET", `${companion(id)}/skills`),
    toggleOfficialSkill: (id, skillId, enabled) => send("PUT", `${companion(id)}/skills/${encodeURIComponent(skillId)}`, { enabled }),
    saveOwnSkill: (id, input, skillId) => skillId
      ? send("PUT", `${companion(id)}/own-skills/${encodeURIComponent(skillId)}`, input)
      : send("POST", `${companion(id)}/own-skills`, input),
    deleteOwnSkill: (id, skillId) => send("DELETE", `${companion(id)}/own-skills/${encodeURIComponent(skillId)}`),
    listChats() {
      return send("GET", "/v0/chats");
    },
    openChat(companionIds: string[], title?: string, key?: string) {
      return send(
        "POST",
        "/v0/chats",
        { companionIds, ...(title ? { title } : {}) },
        key ?? makeIdempotencyKey("chat-open"),
      );
    },
    getChat(chatId: string, cursor?: string) {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return send("GET", `/v0/chats/${encodeURIComponent(chatId)}${q}`);
    },
    deleteChat(chatId: string) {
      return send("DELETE", `/v0/chats/${encodeURIComponent(chatId)}`);
    },
    sendMessage(chatId: string, body: string, mentions?: string[], idempotencyKey?: string) {
      return send(
        "POST",
        `/v0/chats/${encodeURIComponent(chatId)}/messages`,
        { body, ...(mentions && mentions.length > 0 ? { mentions } : {}) },
        idempotencyKey ?? makeIdempotencyKey("chat-msg"),
      );
    },
    retryMessage(chatId: string, messageId: string) {
      return send(
        "POST",
        `/v0/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/retry`,
        undefined,
        makeIdempotencyKey("chat-retry"),
      );
    },
    getChatSettings(companionId: string) {
      return send("GET", `/v0/companions/${encodeURIComponent(companionId)}/chat-settings`);
    },
    updateChatSettings(companionId: string, settings: ChatSettings) {
      return send("PUT", `/v0/companions/${encodeURIComponent(companionId)}/chat-settings`, settings);
    },
    sendAction(companionId, action, key) {
      return send("POST", `/v0/companions/${encodeURIComponent(companionId)}/actions`, { action }, key);
    },
    listModels() {
      return send("GET", "/v0/chat-models");
    },
  };
}
