import type {
  Anniversary, Badges, CompanionMemory, MemoryList, CompanionConnection, ConnectionInput, ConnectionSaveResult,
  Chat,
  ChatModelList,
  ChatPage,
  ChatSendResult,
  ChatSettings,
  CompanionActionResult,
} from "../../../contracts/chat.ts";

import type { CompanionAction } from "../../../contracts/companion-actions.ts";

interface ChatRetryResult {
  typing: string[];
  replying: boolean;
}

export type { ChatModelInfo as ChatModelItem, ChatModelList } from "../../../contracts/chat.ts";

export interface ChatClient {
  badges?(): Promise<Badges>;
  markRead?(chatId: string, messageId: string): Promise<Chat>;
  getAnniversary?(id: string): Promise<Anniversary>;
  saveAnniversary?(id: string, value: Pick<Anniversary, "startDate" | "timeZone" | "revision">): Promise<Anniversary>;
  listMemories?(id: string): Promise<MemoryList>;
  addMemory?(id: string, body: string, key: string): Promise<CompanionMemory>;
  deleteMemory?(id: string, memoryId: string): Promise<unknown>;
  getConnection?(id: string): Promise<CompanionConnection>;
  saveConnection?(id: string, input: ConnectionInput): Promise<ConnectionSaveResult>;
  removeConnection?(id: string): Promise<CompanionConnection>;
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

export function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createChatClient(send: SendFn): ChatClient {
  const companion = (id: string) => `/v0/companions/${encodeURIComponent(id)}`;
  return {
    badges: () => send("GET", "/v0/badges"),
    markRead: (id, messageId) => send("PUT", `/v0/chats/${encodeURIComponent(id)}/read`, { messageId }),
    getAnniversary: id => send("GET", `${companion(id)}/anniversary`),
    saveAnniversary: (id, value) => send("PUT", `${companion(id)}/anniversary`, value),
    listMemories: id => send("GET", `${companion(id)}/memories`),
    addMemory: (id, body, key) => send("POST", `${companion(id)}/memories`, { body }, key),
    deleteMemory: (id, memoryId) => send("DELETE", `${companion(id)}/memories/${encodeURIComponent(memoryId)}`),
    getConnection: id => send("GET", `${companion(id)}/connection`),
    saveConnection: (id, input) => send("PUT", `${companion(id)}/connection`, input),
    removeConnection: id => send("DELETE", `${companion(id)}/connection`),
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
