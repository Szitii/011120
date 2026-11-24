/**
 * Chat routes. Authentication runs in MvpApiBoundary first; every call goes to the database as
 * the signed-in Owner, which checks that the chat and the Companions are theirs.
 *
 *   GET    /v0/chats                                   every chat, most recently active first
 *   POST   /v0/chats                                   { companionIds, title? }  one-to-one or a new group
 *   GET    /v0/chats/{id}?cursor=                      the chat and a page of messages, newest first
 *   DELETE /v0/chats/{id}                              delete the chat and its messages
 *   POST   /v0/chats/{id}/messages                     { body, mentions? }       send
 *   POST   /v0/chats/{id}/messages/{messageId}/retry   try a failed reply again
 *   GET|PUT /v0/companions/{id}/chat-settings          how a Companion takes part, and its model
 *   GET    /v0/chat-models                             the models an Owner can pick
 *   POST   /v0/companions/{id}/actions                 { action }  a home-room action, kept in the one-to-one chat
 *   GET    /v0/companions/{id}/diary?cursor=           the Companion's diary, newest first
 *   POST   /v0/companions/{id}/diary                   write an entry if one is due (waits for the model)
 *   DELETE /v0/companions/{id}/diary/{entryId}         erase an entry
 *   GET|PUT /v0/companions/{id}/diary-settings         how often it writes
 *   GET|POST /v0/companions/{id}/memories              its long-term memories; { body } adds one
 *   DELETE /v0/companions/{id}/memories/{memoryId}     delete one
 *
 * POST /v0/chats, POST .../messages and POST .../actions need an Idempotency-Key. After a send, a retry, or a read
 * while replies are on the way, the replies are written in the background (see replies.ts).
 */
import { sha256 } from "../companion-import/canonical.ts";
import { hasCredential } from "../companion-import/policy.ts";
import { PostgresPersistenceError } from "../persistence/postgres/types.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, MvpHttpResponse } from "../http/types.ts";
import type { ChatModelList, ChatSettings, DiarySettings } from "../../../contracts/chat.ts";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import type { ChatCatalog } from "./models.ts";
import type { ChatPort } from "./port.ts";
import type { ChatReplies } from "./replies.ts";

// Same names as contracts/companion-actions.ts (checked again by the database).
const ACTIONS: readonly CompanionAction[] = ["WAVE", "PAT_HEAD", "HUG", "CUDDLE"];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid = (): never => { throw new PostgresPersistenceError("INVALID_INPUT", "Invalid chat request."); };
const notFound = (): never => { throw new PostgresPersistenceError("NOT_FOUND", "Chat route not found."); };
const id = (value: unknown): string => typeof value === "string" && UUID.test(value) ? value : invalid();
const header = (request: MvpHttpRequest, name: string): string | undefined =>
  Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
const ids = (value: unknown, min: number): string[] =>
  Array.isArray(value) && value.length >= min && value.length <= 8 ? value.map(id) : invalid();

/** A JSON object body with only the allowed keys. */
function body(request: MvpHttpRequest, allowed: readonly string[]): Record<string, unknown> {
  const value = request.body;
  if (header(request, "content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
    || !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) return invalid();
  return value as Record<string, unknown>;
}

/** The caller's Idempotency-Key, scoped to the Owner so two accounts never share it. */
function retryKey(request: MvpHttpRequest, ownerId: string): string {
  const key = header(request, "idempotency-key");
  return key && key.length >= 16 && key.length <= 128 ? sha256(`chat:${ownerId}:${key}`) : invalid();
}

/** Text the way the database counts it: trimmed, in characters (an emoji is one). */
function text(value: unknown, max: number): string {
  if (typeof value !== "string") return invalid();
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  return length >= 1 && length <= max ? trimmed : invalid();
}

/** Every setting is required; `model` is null (platform default) or an id from the catalog. */
function settings(request: MvpHttpRequest, catalog: ChatCatalog | undefined): ChatSettings {
  const { groupActivity, companionInteraction, model, revision } =
    body(request, ["groupActivity", "companionInteraction", "model", "revision"]);
  if (!["QUIET", "NORMAL", "ACTIVE"].includes(groupActivity as string)
    || !["NONE", "RARE", "NORMAL", "LIVELY"].includes(companionInteraction as string)
    || !(model === null || (typeof model === "string" && catalog?.has(model)))
    || !Number.isInteger(revision) || (revision as number) < 1 || (revision as number) > 2147483647) return invalid();
  return { groupActivity, companionInteraction, model, revision } as ChatSettings;
}

function diarySettings(request: MvpHttpRequest): DiarySettings {
  const { frequency, revision } = body(request, ["frequency", "revision"]);
  if (!["OFF", "RARE", "DAILY", "OFTEN"].includes(frequency as string)
    || !Number.isInteger(revision) || (revision as number) < 1 || (revision as number) > 2147483647) return invalid();
  return { frequency, revision } as DiarySettings;
}

/** The catalog with what can be used right now: enabled, key configured, not switched off. */
async function models(port: ChatPort, catalog: ChatCatalog | undefined): Promise<ChatModelList> {
  if (catalog === undefined) return { items: [], defaultModel: null };
  const switchedOn = await port.modelsEnabled(catalog.models);
  const items = catalog.models.map((m, i) => ({
    id: m.id, name: m.name, provider: m.provider, tier: m.tier, inputPerMTok: m.inputPerMTok, outputPerMTok: m.outputPerMTok,
    available: catalog.usable(m) && switchedOn[i] === true,
  }));
  const fallback = catalog.defaultModel();
  return { items, defaultModel: items.find(item => item.id === fallback?.id && item.available)?.id ?? null };
}

function cursor(url: URL): [string | null, string | null] {
  const value = url.searchParams.get("cursor");
  if (value === null) return [null, null];
  const [at, last, ...rest] = value.split("|");
  if (!at || !last || rest.length > 0 || !Number.isFinite(Date.parse(at))) return invalid();
  return [at, id(last)];
}

/** Replies are on the way (a send, a retry, or a chat page). */
const replying = (payload: unknown): boolean => {
  const value = payload as { replying?: unknown; chat?: { replying?: unknown } };
  return (value.replying ?? value.chat?.replying) === true;
};

export async function handleChatRequest(
  request: MvpHttpRequest, session: AuthenticatedOwnerSession, traceId: string, replies: ChatReplies, catalog?: ChatCatalog,
): Promise<MvpHttpResponse | undefined> {
  const url = new URL(request.url, "https://chat.invalid");
  const path = url.pathname.replace(/\/$/, "").split("/").slice(1); // ["v0", ...]
  const settingsRoute = path[1] === "companions" && path[3] === "chat-settings" && path.length === 4;
  const modelsRoute = path[1] === "chat-models" && path.length === 2;
  const actionsRoute = path[1] === "companions" && path[3] === "actions" && path.length === 4;
  const diaryRoute = path[1] === "companions" && path[3] === "diary" && (path.length === 4 || path.length === 5);
  const diarySettingsRoute = path[1] === "companions" && path[3] === "diary-settings" && path.length === 4;
  const memoriesRoute = path[1] === "companions" && path[3] === "memories" && (path.length === 4 || path.length === 5);
  if (path[0] !== "v0" || (path[1] !== "chats" && !settingsRoute && !modelsRoute && !actionsRoute && !diaryRoute
    && !diarySettingsRoute && !memoriesRoute)) return undefined;
  const port = session.chat;
  const response = (status: number, payload: unknown): MvpHttpResponse => ({
    status, body: payload, headers: { "content-type": "application/json", "cache-control": "no-store", "x-trace-id": traceId },
  });
  if (!port) return response(501, { code: "CHAT_UNAVAILABLE" });
  const method = request.method.toUpperCase();

  if (modelsRoute) return method === "GET" ? response(200, await models(port, catalog)) : notFound();
  if (settingsRoute) {
    const companionId = id(path[2]);
    if (method === "GET") return response(200, await port.settings(companionId));
    if (method === "PUT") return response(200, await port.saveSettings(companionId, settings(request, catalog)));
    return notFound();
  }
  if (actionsRoute) {
    if (method !== "POST") return notFound();
    const companionId = id(path[2]);
    const { action } = body(request, ["action"]);
    if (!ACTIONS.includes(action as CompanionAction)) return invalid();
    const result = await port.act(companionId, action as CompanionAction, retryKey(request, session.ownerId));
    const chatId = (result as { chatId?: unknown }).chatId;
    if (replying(result) && typeof chatId === "string") replies.kick(chatId, port);
    return response(201, result);
  }
  if (diarySettingsRoute) {
    const companionId = id(path[2]);
    if (method === "GET") return response(200, await port.diarySettings(companionId));
    if (method === "PUT") return response(200, await port.saveDiarySettings(companionId, diarySettings(request)));
    return notFound();
  }
  if (memoriesRoute) {
    const companionId = id(path[2]);
    if (path.length === 5) return method === "DELETE" ? response(200, await port.deleteMemory(companionId, id(path[4]))) : notFound();
    if (method === "GET") return response(200, await port.memories(companionId));
    if (method !== "POST") return notFound();
    // A memory is sent to the model with every reply: no keys or passwords in it.
    const memory = text(body(request, ["body"]).body, 500);
    if (hasCredential(memory)) return invalid();
    return response(201, await port.addMemory(companionId, memory, retryKey(request, session.ownerId)));
  }
  if (diaryRoute) {
    const companionId = id(path[2]);
    if (path.length === 5) return method === "DELETE" ? response(200, await port.deleteDiary(companionId, id(path[4]))) : notFound();
    if (method === "GET") return response(200, await port.diary(companionId, ...cursor(url)));
    if (method === "POST") return response(200, await replies.writeDiary(companionId, port));
    return notFound();
  }
  const [, , chatId, part, messageId, action] = path;
  if (chatId === undefined) {
    if (method === "GET") return response(200, await port.list());
    if (method !== "POST") return notFound();
    const input = body(request, ["companionIds", "title"]);
    const title = input.title === undefined || input.title === null ? null : text(input.title, 40);
    return response(200, await port.open(ids(input.companionIds, 1), title, retryKey(request, session.ownerId)));
  }
  const chat = id(chatId);
  let result: unknown;
  if (part === undefined && method === "GET") {
    const [beforeAt, beforeId] = cursor(url);
    result = await port.read(chat, beforeAt, beforeId);
  } else if (part === undefined && method === "DELETE") {
    return response(200, await port.remove(chat));
  } else if (part === "messages" && messageId === undefined && method === "POST") {
    const input = body(request, ["body", "mentions"]);
    const mentions = input.mentions === undefined ? [] : ids(input.mentions, 0);
    result = await port.send(chat, text(input.body, 2000), mentions, retryKey(request, session.ownerId));
  } else if (part === "messages" && action === "retry" && path.length === 6 && method === "POST") {
    result = await port.retry(chat, id(messageId));
  } else {
    return notFound();
  }
  if (replying(result)) replies.kick(chat, port);
  return response(part === "messages" && action === undefined ? 201 : 200, result);
}
