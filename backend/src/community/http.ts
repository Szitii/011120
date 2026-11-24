import { sha256 } from "../companion-import/canonical.ts";
import { PostgresPersistenceError } from "../persistence/postgres/types.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, MvpHttpResponse } from "../http/types.ts";
import type { CommunityCommand, CommunityPort, CommunityRead } from "./port.ts";
import { AGENT_TOOLS, WRITE_TOOLS, runAgentTool, type AgentArgs, type AgentTool } from "../agent/tools.ts";
import type { AgentSettings, HumanProfileSettings } from "../../../contracts/community.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid = (): never => { throw new PostgresPersistenceError("INVALID_INPUT", "Invalid community request."); };
const id = (value: string | null): string => value !== null && uuid.test(value) ? value : invalid();
const header = (request: MvpHttpRequest, name: string): string | undefined =>
  Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
const isJson = (request: MvpHttpRequest): boolean =>
  header(request, "content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
type Respond = (status: number, body: unknown) => MvpHttpResponse;

/** Keyset cursor "createdAt|id" from `?cursor=`, as [beforeAt, beforeId]; both null without one. */
function cursorOf(url: URL): [string | null, string | null] {
  const cursor = url.searchParams.get("cursor");
  if (cursor === null) return [null, null];
  const parts = cursor.split("|");
  if (parts.length !== 2 || !parts[0] || !Number.isFinite(Date.parse(parts[0]))) invalid();
  return [parts[0]!, id(parts[1]!)];
}

/** The caller's Idempotency-Key, scoped to the Owner so two accounts never share replay storage. */
function retryKey(request: MvpHttpRequest, ownerId: string): string {
  const key = header(request, "idempotency-key");
  return key && key.length >= 16 && key.length <= 128 ? sha256(`${ownerId}:${key}`) : invalid();
}

function profileSettings(request: MvpHttpRequest): HumanProfileSettings {
  if (!isJson(request)) return invalid();
  const input = request.body;
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  if (Object.keys(input).some(key => !["displayName", "bio", "revision"].includes(key))) return invalid();
  const { displayName, bio, revision } = input as Record<string, unknown>;
  if (typeof displayName !== "string" || typeof bio !== "string" || typeof revision !== "number"
    || !Number.isInteger(revision) || revision < 1 || revision > 2147483647) return invalid();
  const name = displayName.trim();
  const description = bio.replaceAll("\r\n", "\n").trim();
  if (name.length === 0 || Array.from(name).length > 80 || Array.from(description).length > 500
    || /[\x00-\x1f\x7f]/.test(name) || /[\x00-\x08\x0b-\x1f\x7f]/.test(description)) return invalid();
  return { displayName: name, bio: description, revision };
}

// Shape of PUT agent/settings: every field is required. Value ranges are checked by the database.
const SETTING_TYPES = {
  paused: "boolean", autoEnabled: "boolean", intervalMinutes: "integer", activeFrom: "time", activeTo: "time",
  timeZone: "zone", canPost: "boolean", canComment: "boolean", canFollow: "boolean", publishMode: "mode",
  dailyPosts: "integer", dailyComments: "integer", dailyFollows: "integer", commentsPerPost: "integer", revision: "integer",
} as const;

function agentSettings(request: MvpHttpRequest): AgentSettings {
  const input = request.body as Record<string, unknown> | undefined;
  if (!isJson(request) || !input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== Object.keys(SETTING_TYPES).length) return invalid();
  for (const [name, type] of Object.entries(SETTING_TYPES)) {
    const value = input[name];
    const ok = type === "boolean" ? typeof value === "boolean"
      : type === "integer" ? Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647
      : type === "time" ? typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
      : type === "mode" ? value === "DRAFT" || value === "DIRECT"
      : typeof value === "string" && value.length >= 1 && value.length <= 64;
    if (!ok) invalid();
  }
  return input as unknown as AgentSettings;
}

/**
 * /v0/community/agent/...: the Owner's settings and drafts for one Companion, and the AI text tools.
 *   GET|PUT settings · GET drafts · POST drafts/{id}/publish|discard · POST {tool} -> { "text": "..." }
 * Tool arguments are a JSON object with only string `postId`, `actorId`, `text` (checked by the database);
 * the write tools (post, comment, follow, unfollow) need an Idempotency-Key.
 */
async function agentRoute(
  request: MvpHttpRequest, session: AuthenticatedOwnerSession, port: CommunityPort,
  actor: CommunityRead["actor"], route: string[], method: string, response: Respond,
): Promise<MvpHttpResponse> {
  const [name, draftId, decision] = route;
  if (name === "settings" && route.length === 1) {
    if (method === "GET") return response(200, await port.agentSettings(actor));
    if (method === "PUT") return response(200, await port.saveAgentSettings(actor, agentSettings(request)));
  }
  if (name === "drafts" && route.length === 1 && method === "GET") return response(200, await port.agentDrafts(actor));
  if (name === "drafts" && route.length === 3 && method === "POST" && (decision === "publish" || decision === "discard")) {
    return response(200, await port.decideAgentDraft(actor, id(draftId!), decision === "publish"));
  }
  if (route.length !== 1 || method !== "POST" || name === "settings" || name === "drafts") {
    return response(404, { code: "RESOURCE_NOT_FOUND" });
  }
  if (!(AGENT_TOOLS as readonly string[]).includes(name!)) {
    return response(404, { text: `没有这个工具。可用：${AGENT_TOOLS.join("、")}。` });
  }
  const args = request.body ?? {};
  if ((request.body !== undefined && !isJson(request)) || typeof args !== "object" || Array.isArray(args)
    || Object.entries(args).some(([k, v]) => !["postId", "actorId", "text"].includes(k) || typeof v !== "string")) {
    return invalid();
  }
  const keyHash = WRITE_TOOLS.includes(name as AgentTool) ? retryKey(request, session.ownerId) : null;
  const result = await runAgentTool(port, actor, name as AgentTool, args as AgentArgs, keyHash);
  return response(result.status, { text: result.text });
}

/** Authentication runs in MvpApiBoundary before this router; no user-supplied Owner id is trusted. */
export async function handleCommunityRequest(
  request: MvpHttpRequest, session: AuthenticatedOwnerSession, traceId: string,
): Promise<MvpHttpResponse | undefined> {
  const url = new URL(request.url, "https://community.invalid");
  if (!url.pathname.startsWith("/v0/community/")) return undefined;
  const port = session.community;
  const response: Respond = (status, body) => ({
    status, body, headers: { "content-type": "application/json", "cache-control": "no-store", "x-trace-id": traceId },
  });
  if (!port) return response(501, { code: "COMMUNITY_UNAVAILABLE" });

  const kind = url.searchParams.get("actorKind");
  if (kind !== "OWNER" && kind !== "COMPANION" && kind !== "SOCIAL_TWIN") invalid();
  const actor = { kind, id: id(url.searchParams.get("actorId")) } as CommunityRead["actor"];
  const route = url.pathname.slice("/v0/community/".length).split("/");
  const method = request.method.toUpperCase();
  if (route[0] === "agent") return agentRoute(request, session, port, actor, route.slice(1), method, response);
  if (route[0] === "profile" && route[1] === "settings" && route.length === 2) {
    if (method === "GET") return response(200, await port.humanProfileSettings(actor));
    if (method === "PUT") return response(200, await port.saveHumanProfile(actor, profileSettings(request)));
  }
  if (method === "GET" && (route[0] === "following" || route[0] === "followers") && route.length === 1) {
    const [beforeAt, beforeId] = cursorOf(url);
    return response(200, await port.followList({
      actor, direction: route[0] === "following" ? "FOLLOWING" : "FOLLOWERS", beforeAt, beforeId,
    }));
  }
  let resource: CommunityRead["resource"] | undefined;
  let targetId: string | null = null;
  if (method === "GET") {
    if (route[0] === "profile" && route.length <= 2) { resource = "profile"; targetId = route[1] ? id(route[1]) : null; }
    if (route[0] === "feed" && route.length === 1) { resource = "feed"; targetId = url.searchParams.has("authorId") ? id(url.searchParams.get("authorId")) : null; }
    if (route[0] === "posts" && route.length === 2) { resource = "detail"; targetId = id(route[1]!); }
    if (route[0] === "blocks" && route.length === 1) resource = "blocks";
    if (route[0] === "notifications" && route.length === 1) resource = "notifications";
    if (!resource) return response(404, { code: "RESOURCE_NOT_FOUND" });
    const mode = url.searchParams.get("mode") ?? "LATEST";
    const filter = url.searchParams.get("filter") ?? "ALL";
    if (mode !== "LATEST" && mode !== "FOLLOWING") invalid();
    if (filter !== "ALL" && filter !== "HUMAN" && filter !== "AI") invalid();
    const [beforeAt, beforeId] = cursorOf(url);
    return response(200, await port.read({ actor, resource, targetId, mode, filter, beforeAt, beforeId } as CommunityRead));
  }

  // Setting a like twice changes nothing, so it needs no Idempotency-Key.
  if ((method === "PUT" || method === "DELETE") && route[0] === "posts" && route[2] === "like" && route.length === 3) {
    if (request.body !== undefined) invalid();
    return response(200, await port.like(actor, id(route[1]!), method === "PUT"));
  }

  let action: CommunityCommand["action"] | undefined;
  if (method === "POST" && route[0] === "posts" && route.length === 1) action = "POST";
  if (method === "POST" && route[0] === "posts" && route[2] === "comments" && route.length === 3) {
    action = "COMMENT"; targetId = id(route[1]!);
  }
  if ((method === "PUT" || method === "DELETE") && route[0] === "following" && route.length === 2) {
    action = method === "PUT" ? "FOLLOW" : "UNFOLLOW"; targetId = id(route[1]!);
  }
  if (method === "DELETE" && (route[0] === "posts" || route[0] === "comments") && route.length === 2) {
    action = route[0] === "posts" ? "DELETE_POST" : "DELETE_COMMENT"; targetId = id(route[1]!);
  }
  if (method === "PUT" && route[0] === "notifications" && route[2] === "read" && route.length === 3) {
    action = "READ_NOTIFICATION"; targetId = id(route[1]!);
  }
  if ((method === "PUT" || method === "DELETE") && route[0] === "blocks" && route.length === 2) {
    action = method === "PUT" ? "BLOCK" : "UNBLOCK"; targetId = id(route[1]!);
  }
  if (method === "POST" && route[0] === "reports" && route.length === 3) {
    const actions = { actors: "REPORT_ACTOR", posts: "REPORT_POST", comments: "REPORT_COMMENT" } as const;
    action = actions[route[1] as keyof typeof actions]; targetId = id(route[2]!);
  }
  if (!action) return response(404, { code: "RESOURCE_NOT_FOUND" });
  const keyHash = retryKey(request, session.ownerId);
  let body: string | null = null;
  if (action === "POST" || action === "COMMENT") {
    if (!isJson(request)) invalid();
    const value = request.body as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => k !== "body")) invalid();
    if (typeof value!.body !== "string") invalid();
    body = (value!.body as string).trim();
    // Count characters the way the database does (code points), so an emoji counts as one, not two.
    const characters = Array.from(body).length;
    if (characters < 1 || characters > (action === "POST" ? 4000 : 2000)) invalid();
  } else if (action.startsWith("REPORT_")) {
    if (!isJson(request)) invalid();
    const value = request.body as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(k => k !== "reason" && k !== "details")) return invalid();
    if (typeof value.reason !== "string" || !["SPAM","HARASSMENT","HARMFUL","PRIVACY","OTHER"].includes(value.reason)
      || typeof value.details !== "string" || Array.from(value.details).length > 1000
      || /[\x00-\x08\x0b-\x1f\x7f]/.test(value.details)) return invalid();
    body = JSON.stringify({ reason: value.reason, details: value.details.trim() });
  } else if (request.body !== undefined) invalid();
  const result = await port.command({
    actor, action, targetId, body,
    keyHash,
    requestHash: sha256(JSON.stringify({ actor, action, targetId, body })),
  });
  return response(action === "POST" || action === "COMMENT" ? 201 : 200, result);
}
