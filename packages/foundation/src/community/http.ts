import { createHash } from "node:crypto";
import { PostgresPersistenceError } from "../persistence/postgres/types.ts";
import type { AuthenticatedOwnerSession, MvpHttpRequest, MvpHttpResponse } from "../http/types.ts";
import type { CommunityCommand, CommunityRead } from "./port.ts";
import type { HumanProfileSettings } from "../../../community-contracts/types.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid = (): never => { throw new PostgresPersistenceError("INVALID_INPUT", "Invalid community request."); };
const id = (value: string | null): string => value !== null && uuid.test(value) ? value : invalid();
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function profileSettings(request: MvpHttpRequest): HumanProfileSettings {
  const contentType = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === "content-type")?.[1];
  if (contentType?.split(";")[0]?.trim().toLowerCase() !== "application/json") return invalid();
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

/** Authentication runs in MvpApiBoundary before this router; no user-supplied Owner id is trusted. */
export async function handleCommunityRequest(
  request: MvpHttpRequest, session: AuthenticatedOwnerSession, traceId: string,
): Promise<MvpHttpResponse | undefined> {
  const url = new URL(request.url, "https://community.invalid");
  if (!url.pathname.startsWith("/v0/community/")) return undefined;
  const port = session.community;
  const response = (status: number, body: unknown): MvpHttpResponse => ({
    status, body, headers: { "content-type": "application/json", "cache-control": "no-store", "x-trace-id": traceId },
  });
  if (!port) return response(501, { code: "COMMUNITY_UNAVAILABLE" });

  const kind = url.searchParams.get("actorKind");
  if (kind !== "OWNER" && kind !== "COMPANION" && kind !== "SOCIAL_TWIN") invalid();
  const actor = { kind, id: id(url.searchParams.get("actorId")) } as CommunityRead["actor"];
  const route = url.pathname.slice("/v0/community/".length).split("/");
  const method = request.method.toUpperCase();
  if (route[0] === "profile" && route[1] === "settings" && route.length === 2) {
    if (method === "GET") return response(200, await port.humanProfileSettings(actor));
    if (method === "PUT") return response(200, await port.saveHumanProfile(actor, profileSettings(request)));
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
    let beforeAt: string | null = null;
    let beforeId: string | null = null;
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null) {
      const parts = cursor.split("|");
      if (parts.length !== 2 || !parts[0] || !Number.isFinite(Date.parse(parts[0]))) invalid();
      beforeAt = parts[0]!; beforeId = id(parts[1]!);
    }
    return response(200, await port.read({ actor, resource, targetId, mode, filter, beforeAt, beforeId } as CommunityRead));
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
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const key = headers["idempotency-key"];
  if (!key || key.length < 16 || key.length > 128) invalid();
  let body: string | null = null;
  if (action === "POST" || action === "COMMENT") {
    if (headers["content-type"]?.split(";")[0]?.trim() !== "application/json") invalid();
    const value = request.body as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => k !== "body")) invalid();
    if (typeof value!.body !== "string") invalid();
    body = (value!.body as string).trim();
    if (body.length < 1 || body.length > (action === "POST" ? 4000 : 2000)) invalid();
  } else if (action.startsWith("REPORT_")) {
    if (headers["content-type"]?.split(";")[0]?.trim() !== "application/json") invalid();
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
    keyHash: digest(`${session.ownerId}:${key}`),
    requestHash: digest(JSON.stringify({ actor, action, targetId, body })),
  });
  return response(action === "POST" || action === "COMMENT" ? 201 : 200, result);
}
