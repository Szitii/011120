import type {
  Chat,
  ChatModelList,
  ChatPage,
  ChatSendResult,
  ChatSettings,
} from "../../../contracts/chat.ts";

export interface ChatRetryResult {
  typing: string[];
  replying: boolean;
}

export type { ChatModelInfo as ChatModelItem, ChatModelList } from "../../../contracts/chat.ts";

export interface ChatClient {
  listChats(): Promise<{ items: Chat[] }>;
  openChat(companionIds: string[], title?: string): Promise<Chat>;
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
  return {
    listChats() {
      return send("GET", "/v0/chats");
    },
    openChat(companionIds: string[], title?: string) {
      return send(
        "POST",
        "/v0/chats",
        { companionIds, ...(title ? { title } : {}) },
        makeIdempotencyKey("chat-open"),
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
    listModels() {
      return send("GET", "/v0/chat-models");
    },
  };
}
