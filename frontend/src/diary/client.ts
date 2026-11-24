import type { DiaryPage, DiarySettings, DiaryWriteResult } from "../../../contracts/chat.ts";

// Older servers omit autoWrite. Frequency-only saves leave the server's choice alone.
export type DiaryPreferences = DiarySettings & { autoWrite?: boolean };

export interface DiaryClient {
  list(companionId: string, cursor?: string): Promise<DiaryPage>;
  writeIfDue(companionId: string): Promise<DiaryWriteResult>;
  remove(companionId: string, entryId: string): Promise<{ deleted: true }>;
  getSettings(companionId: string): Promise<DiaryPreferences>;
  saveSettings(companionId: string, settings: DiaryPreferences): Promise<DiaryPreferences>;
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
