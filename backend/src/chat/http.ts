/**
 * Chat routes. Authentication runs in MvpApiBoundary first; every call goes to the database as
 * the signed-in Owner, which checks that the chat and the Companions are theirs.
 *
 *   GET    /v0/chats                                   every chat, most recently active first
 *   POST   /v0/chats                                   { companionIds, title? }  one-to-one or a new group
 *   GET    /v0/chats/{id}?cursor=                      the chat and a page of messages, newest first
 *   DELETE /v0/chats/{id}                              delete the chat and its messages
 *   PUT    /v0/chats/{id}/read                         { messageId }  the Owner has read up to here
 *   GET    /v0/badges                                  every unread count for the tab badges
 *   GET|PUT /v0/companions/{id}/anniversary            the day the Owner and the Companion count from
 *   POST   /v0/chats/{id}/messages                     { body, mentions? }       send
 *   POST   /v0/chats/{id}/messages/{messageId}/retry   try a failed reply again
 *   POST   /v0/chats/{id}/voice                        { audio, mime, durationMs }  the Owner's voice message
 *   GET    /v0/chats/{id}/messages/{messageId}/audio   a voice message's audio (supports Range)
 *   GET|PUT /v0/companions/{id}/chat-settings          how a Companion takes part, its model and its voice
 *   GET    /v0/chat-models                             the models an Owner can pick
 *   GET    /v0/voices                                  the voices an Owner can pick
 *   GET    /v0/voices/{id}/sample                      hear one
 *   POST   /v0/companions/{id}/actions                 { action }  a home-room action, kept in the one-to-one chat
 *   GET    /v0/companions/{id}/diary?cursor=           the Companion's diary, newest first
 *   POST   /v0/companions/{id}/diary                   write an entry if one is due (waits for the model)
 *   DELETE /v0/companions/{id}/diary/{entryId}         erase an entry
 *   GET|PUT /v0/companions/{id}/diary-settings         how often it writes
 *   GET|POST /v0/companions/{id}/memories              its long-term memories; { body } adds one
 *   DELETE /v0/companions/{id}/memories/{memoryId}     delete one
 *   GET|PUT|DELETE /v0/companions/{id}/connection      how it speaks: the platform, the Owner's own key, or own agent
 *
 * POST /v0/chats, POST .../messages, POST .../voice and POST .../actions need an Idempotency-Key. After a send, a retry, or a read
 * while replies are on the way, the replies are written in the background (see replies.ts).
 */
import { sha256 } from "../companion-import/canonical.ts";
import { hasCredential } from "../companion-import/policy.ts";
import { PostgresPersistenceError } from "../persistence/postgres/types.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, MvpHttpResponse } from "../http/types.ts";
import type { ChatModelList, ChatSettings, DiarySettings, VoiceList } from "../../../contracts/chat.ts";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import type { ChatCatalog } from "./models.ts";
import { checkConnection, type Connections } from "../connections/model.ts";
import type { ConnectionInput, ConnectionSaveResult, CompanionConnection } from "../../../contracts/chat.ts";
import type { ChatPort } from "./port.ts";
import type { ChatReplies } from "./replies.ts";
import { RECORDING_TYPES, type Heard, type RecordingType, type Voices } from "./voices.ts";

/** A voice message: at most a minute, sent as base64 in JSON. */
const MAX_RECORDING_BYTES = 700 * 1024;
const MAX_RECORDING_MS = 60_000;
export const MAX_VOICE_REQUEST_BYTES = 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RECOGNITION_TIMEOUT_MS = 30_000;

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

/**
 * Every setting is required but `voice`; `model` is null (platform default) or an id from the
 * catalog; `voice` is null (text only) or an id from the voice catalog, and left out keeps the current one.
 */
function settings(request: MvpHttpRequest, catalog: ChatCatalog | undefined, voices: Voices | undefined): ChatSettings {
  const { groupActivity, companionInteraction, model, voice, revision } =
    body(request, ["groupActivity", "companionInteraction", "model", "voice", "revision"]);
  if (!["QUIET", "NORMAL", "ACTIVE"].includes(groupActivity as string)
    || !["NONE", "RARE", "NORMAL", "LIVELY"].includes(companionInteraction as string)
    || !(model === null || (typeof model === "string" && catalog?.has(model)))
    || !(voice === undefined || voice === null || (typeof voice === "string" && voices?.catalog.find(voice) !== undefined))
    || !Number.isInteger(revision) || (revision as number) < 1 || (revision as number) > 2147483647) return invalid();
  return { groupActivity, companionInteraction, model, ...(voice === undefined ? {} : { voice }), revision } as ChatSettings;
}

/** Audio bytes, or the part a Range header asks for (players seek and stream with it). */
function audio(request: MvpHttpRequest, clip: { mime: string; bytes: Uint8Array }, traceId: string): MvpHttpResponse {
  const total = clip.bytes.length;
  const headers = { "content-type": clip.mime, "accept-ranges": "bytes", "cache-control": "private, max-age=86400", "x-trace-id": traceId };
  const range = /^bytes=(\d*)-(\d*)$/.exec(header(request, "range")?.trim() ?? "");
  if (range === null || (range[1] === "" && range[2] === "")) {
    return { status: 200, headers: { ...headers, "content-length": String(total) }, body: clip.bytes };
  }
  const [start, end] = range[1] === "" ? [Math.max(0, total - Number(range[2])), total - 1]
    : [Number(range[1]), range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1)];
  if (start > end || start >= total) {
    return { status: 416, headers: { ...headers, "content-range": `bytes */${total}`, "content-length": "0" }, body: new Uint8Array() };
  }
  return {
    status: 206, body: clip.bytes.subarray(start, end + 1),
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) },
  };
}

function voiceList(voices: Voices | undefined): VoiceList {
  return {
    items: (voices?.catalog.voices ?? []).map(v => ({ id: v.id, name: v.name, gender: v.gender, description: v.description })),
    available: voices?.available === true,
    input: voices?.listening === true,
  };
}

/** The recording in POST .../voice: a known type, real base64, at most a minute and 700 KB. */
function recording(request: MvpHttpRequest): { mime: RecordingType; durationMs: number; bytes: Uint8Array } {
  const { audio, mime, durationMs } = body(request, ["audio", "mime", "durationMs"]);
  if (typeof audio !== "string" || audio.length === 0 || !BASE64.test(audio) || typeof mime !== "string" || !Object.hasOwn(RECORDING_TYPES, mime)
    || !Number.isInteger(durationMs) || (durationMs as number) < 1 || (durationMs as number) > MAX_RECORDING_MS) return invalid();
  const bytes = Buffer.from(audio, "base64");
  return bytes.length <= MAX_RECORDING_BYTES ? { mime: mime as RecordingType, durationMs: durationMs as number, bytes } : invalid();
}

const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** startDate "YYYY-MM-DD" or null; the database checks the day exists, the range and the time zone. */
function anniversary(request: MvpHttpRequest): [string | null, string, number] {
  const { startDate, timeZone, revision } = body(request, ["startDate", "timeZone", "revision"]);
  if (!(startDate === null || (typeof startDate === "string" && DATE.test(startDate)))
    || typeof timeZone !== "string" || timeZone.length < 1 || timeZone.length > 64
    || !Number.isInteger(revision) || (revision as number) < 1 || (revision as number) > 2147483647) return invalid();
  return [startDate as string | null, timeZone, revision as number];
}

/** The shape of PUT .../connection; the values are checked by checkConnection. */
function connectionInput(request: MvpHttpRequest): ConnectionInput {
  const kind = (request.body as { kind?: unknown } | undefined)?.kind;
  const input = kind === "BYOK" ? body(request, ["kind", "provider", "baseUrl", "model", "apiKey", "consent"])
    : kind === "EXTERNAL" ? body(request, ["kind", "name", "endpoint", "bearerToken", "model", "consent"]) : invalid();
  const strings = kind === "BYOK" ? ["provider", "model", "apiKey"] : ["name", "endpoint", "bearerToken"];
  if (strings.some(key => typeof input[key] !== "string") || typeof input.consent !== "boolean"
    || !(input.baseUrl === undefined || typeof input.baseUrl === "string")
    || (kind === "EXTERNAL" && !(input.model === undefined || input.model === null || typeof input.model === "string"))) return invalid();
  return input as unknown as ConnectionInput;
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
  connections?: Connections,
): Promise<MvpHttpResponse | undefined> {
  const url = new URL(request.url, "https://chat.invalid");
  const path = url.pathname.replace(/\/$/, "").split("/").slice(1); // ["v0", ...]
  const settingsRoute = path[1] === "companions" && path[3] === "chat-settings" && path.length === 4;
  const modelsRoute = path[1] === "chat-models" && path.length === 2;
  const actionsRoute = path[1] === "companions" && path[3] === "actions" && path.length === 4;
  const diaryRoute = path[1] === "companions" && path[3] === "diary" && (path.length === 4 || path.length === 5);
  const diarySettingsRoute = path[1] === "companions" && path[3] === "diary-settings" && path.length === 4;
  const anniversaryRoute = path[1] === "companions" && path[3] === "anniversary" && path.length === 4;
  const badgesRoute = path[1] === "badges" && path.length === 2;
  const memoriesRoute = path[1] === "companions" && path[3] === "memories" && (path.length === 4 || path.length === 5);
  const connectionRoute = path[1] === "companions" && path[3] === "connection" && path.length === 4;
  const voicesRoute = path[1] === "voices" && (path.length === 2 || (path.length === 4 && path[3] === "sample"));
  if (path[0] !== "v0" || (path[1] !== "chats" && !settingsRoute && !modelsRoute && !actionsRoute && !diaryRoute
    && !diarySettingsRoute && !anniversaryRoute && !badgesRoute && !memoriesRoute && !connectionRoute && !voicesRoute)) return undefined;
  const port = session.chat;
  const response = (status: number, payload: unknown): MvpHttpResponse => ({
    status, body: payload, headers: { "content-type": "application/json", "cache-control": "no-store", "x-trace-id": traceId },
  });
  if (!port) return response(501, { code: "CHAT_UNAVAILABLE" });
  const method = request.method.toUpperCase();

  if (modelsRoute) return method === "GET" ? response(200, await models(port, catalog)) : notFound();
  if (voicesRoute) {
    if (method !== "GET") return notFound();
    if (path.length === 2) return response(200, voiceList(replies.voices));
    const voice = replies.voices?.available ? replies.voices.catalog.find(path[2]!) : undefined;
    if (voice === undefined) return notFound();
    return audio(request, await replies.voices!.sample(voice).catch(() => {
      throw new PostgresPersistenceError("DATABASE_UNAVAILABLE", "The voice sample could not be made.");
    }), traceId);
  }
  if (badgesRoute) return method === "GET" ? response(200, await port.badges()) : notFound();
  if (anniversaryRoute) {
    const companionId = id(path[2]);
    if (method === "GET") return response(200, await port.anniversary(companionId));
    if (method === "PUT") return response(200, await port.saveAnniversary(companionId, ...anniversary(request)));
    return notFound();
  }
  if (settingsRoute) {
    const companionId = id(path[2]);
    if (method === "GET") return response(200, await port.settings(companionId));
    if (method !== "PUT") return notFound();
    const next = settings(request, catalog, replies.voices);
    // An app that does not know about voices yet keeps the voice the Owner chose elsewhere.
    const voice = next.voice !== undefined ? next.voice : ((await port.settings(companionId)) as ChatSettings).voice ?? null;
    return response(200, await port.saveSettings(companionId, { ...next, voice }));
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
  if (connectionRoute) {
    const companionId = id(path[2]);
    if (method === "GET") return response(200, await port.connectionView(companionId));
    if (method === "DELETE") return response(200, await port.removeConnection(companionId));
    if (method !== "PUT") return notFound();
    const input = connectionInput(request);
    if (connections === undefined) return response(501, { code: "CONNECTIONS_UNAVAILABLE" });
    const current = await port.connectionView(companionId) as CompanionConnection; // 404 unless it is the Owner's
    const checked = checkConnection(input);
    if (checked === "INVALID_INPUT" || checked === "INVALID_URL") return invalid();
    if (checked === "BLOCKED_ADDRESS") return response(200, { result: "BLOCKED_ADDRESS", connection: current } satisfies ConnectionSaveResult);
    if (!connections.allow(session.ownerId)) return response(429, { code: "TOO_MANY_TESTS" });
    const result = await connections.test(checked);
    if (result !== "CONNECTED") return response(200, { result, connection: current } satisfies ConnectionSaveResult);
    const saved = await port.saveConnection(companionId, { ...checked, secret: connections.box.seal(checked.secret, companionId) },
      // The last 4 characters help the Owner recognise the key; a short one shows nothing, so it is never stored in clear.
      checked.secret.length >= 12 ? checked.secret.slice(-4) : "");
    return response(200, { result, connection: saved as CompanionConnection } satisfies ConnectionSaveResult);
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
  } else if (part === "read" && path.length === 4 && method === "PUT") {
    return response(200, await port.markRead(chat, id(body(request, ["messageId"]).messageId)));
  } else if (part === "messages" && messageId === undefined && method === "POST") {
    const input = body(request, ["body", "mentions"]);
    const mentions = input.mentions === undefined ? [] : ids(input.mentions, 0);
    result = await port.send(chat, text(input.body, 2000), mentions, retryKey(request, session.ownerId));
  } else if (part === "messages" && action === "retry" && path.length === 6 && method === "POST") {
    result = await port.retry(chat, id(messageId));
  } else if (part === "voice" && path.length === 4 && method === "POST") {
    const said = recording(request);
    const key = retryKey(request, session.ownerId);
    const voices = replies.voices;
    if (voices === undefined || !voices.listening) return response(503, { code: "VOICE_UNAVAILABLE" });
    // Checked before paying for recognition; the database checks again when it stores the message.
    if ((await port.voiceLeft()).owner <= 0) return response(429, { code: "VOICE_LIMIT" });
    let heard: Heard;
    try {
      heard = await voices.transcribe(said.bytes, said.mime, AbortSignal.timeout(RECOGNITION_TIMEOUT_MS));
    } catch {
      return response(503, { code: "VOICE_UNAVAILABLE" });
    }
    const words = Array.from(heard.text.replace(/\s+/g, " ").trim()).slice(0, 2000).join("");
    if (words.length === 0) return response(422, { code: "VOICE_NOT_UNDERSTOOD" });
    result = await port.sendVoice(chat, words, said, key);
  } else if (part === "messages" && action === "audio" && path.length === 6 && method === "GET") {
    return audio(request, await port.audio(chat, id(messageId)), traceId);
  } else {
    return notFound();
  }
  if (replying(result)) replies.kick(chat, port);
  return response((part === "messages" && action === undefined) || part === "voice" ? 201 : 200, result);
}
