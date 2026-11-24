import AsyncStorage from "@react-native-async-storage/async-storage";
import { createCommandKey } from "../adapters/real-api";
import { homeStorageKey, type HomeScope } from "../home/keys";
import { keepMedia, removeMedia } from "./mediaFiles";

interface LocalEntry {
  id: string;
  createdAt: string;
  remoteId: string | null;
  syncStatus: "local_only" | "pending" | "synced" | "failed";
}

export interface QuoteInput {
  chatId: string;
  messageId: string;
  speaker: string;
  text: string;
  sentAt: string;
}

export type AlbumEntry = LocalEntry & (
  | { kind: "room_snapshot" | "local_photo"; localPath: string }
  | { kind: "chat_quote"; quote: QuoteInput }
);

const pending = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const current = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  pending.set(key, current);
  void current.finally(() => {
    if (pending.get(key) === current) pending.delete(key);
  }).catch(() => undefined);
  return current;
}

async function read(key: string): Promise<AlbumEntry[]> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  const index = JSON.parse(raw);
  if (index.schemaVersion !== 1 || !Array.isArray(index.items)) throw new Error("照片索引不可读。");
  return index.items;
}

function write(key: string, items: AlbumEntry[]) {
  return AsyncStorage.setItem(key, JSON.stringify({ schemaVersion: 1, items }));
}

function newEntry(): LocalEntry {
  return { id: createCommandKey("album"), createdAt: new Date().toISOString(), remoteId: null, syncStatus: "local_only" };
}

export function listAlbum(scope: HomeScope) {
  const key = homeStorageKey(scope, "album:index");
  return enqueue(key, () => read(key));
}

export function addAlbumPhoto(scope: HomeScope, kind: "room_snapshot" | "local_photo", uri: string, extension: string) {
  const key = homeStorageKey(scope, "album:index");
  return enqueue(key, async () => {
    const items = await read(key);
    const entry = newEntry();
    const suffix = /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : "jpg";
    const localPath = `${entry.id}.${suffix}`;
    try {
      await keepMedia(localPath, uri);
      await write(key, [{ ...entry, kind, localPath }, ...items]);
    } catch (error) {
      await removeMedia(localPath).catch(() => undefined);
      throw error;
    }
  });
}

export function addAlbumQuote(scope: HomeScope, quote: QuoteInput) {
  const key = homeStorageKey(scope, "album:index");
  return enqueue(key, async () => {
    const items = await read(key);
    if (items.some(entry => entry.kind === "chat_quote" && entry.quote.chatId === quote.chatId
      && entry.quote.messageId === quote.messageId)) return;
    await write(key, [{ ...newEntry(), kind: "chat_quote", quote }, ...items]);
  });
}

export function deleteAlbumEntry(scope: HomeScope, id: string) {
  const key = homeStorageKey(scope, "album:index");
  return enqueue(key, async () => {
    const items = await read(key);
    const entry = items.find(item => item.id === id);
    if (!entry) return;
    await write(key, items.filter(item => item.id !== id));
    if (entry.kind !== "chat_quote") await removeMedia(entry.localPath).catch(() => undefined);
  });
}
