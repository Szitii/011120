import type { DiaryPage, DiarySettings, DiaryWriteResult } from "../../../contracts/chat.ts";

export interface DiaryClient {
  list(companionId: string, cursor?: string): Promise<DiaryPage>;
  writeIfDue(companionId: string): Promise<DiaryWriteResult>;
  remove(companionId: string, entryId: string): Promise<{ deleted: true }>;
  getSettings(companionId: string): Promise<DiarySettings>;
  saveSettings(companionId: string, settings: DiarySettings): Promise<DiarySettings>;
}

export function createDiaryClient(send: <T>(method: "GET" | "POST" | "DELETE" | "PUT", path: string, body?: unknown) => Promise<T>): DiaryClient {
  const companion = (id: string) => `/v0/companions/${encodeURIComponent(id)}`;
  return {
    list: (id, cursor) => send("GET", `${companion(id)}/diary${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    writeIfDue: id => send("POST", `${companion(id)}/diary`),
    remove: (id, entryId) => send("DELETE", `${companion(id)}/diary/${encodeURIComponent(entryId)}`),
    getSettings: id => send("GET", `${companion(id)}/diary-settings`),
    saveSettings: (id, settings) => send("PUT", `${companion(id)}/diary-settings`, settings),
  };
}
