import { createHash, randomUUID } from "node:crypto";
import { handleCommunityRequest } from "../community/http.ts";
import { canonicalJson, sha256 } from "../companion-import/canonical.ts";
import { parseCharacterCard, parserMetadata } from "../companion-import/parser.ts";
import { AuthorizationError, ConflictError, ImportPolicyError } from "../companion-import/errors.ts";
import type { PersistentEncounterOrchestrator } from "../encounter/persistent-orchestrator.ts";
import { PostgresPersistenceError } from "../persistence/postgres/types.ts";
import {
  ApiAuthenticationError,
  OwnerSessionError,
  type ApiProblem,
  type AuthenticatedOwnerSession,
  type EncounterCommandPort,
  type MvpHttpRequest,
  type MvpHttpResponse,
  type OwnerSessionResolver,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const JSON_TYPE = "application/json";
const PROBLEM_TYPE = "application/problem+json";
const MAX_BODY_BYTES = 32_768;

type ObjectValue = Record<string, unknown>;

class RequestProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;

  constructor(status: number, code: string, title: string) {
    super(code);
    this.name = "RequestProblem";
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as ObjectValue)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const hash = (value: unknown): string =>
  createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");

const header = (request: MvpHttpRequest, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

const requireUuid = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new RequestProblem(400, "INVALID_REQUEST", `${name} must be a UUID.`);
  }
  return value;
};

const requireString = (
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string => {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new RequestProblem(400, "INVALID_REQUEST", `${name} is invalid.`);
  }
  return value;
};

const requireAnyObject = (request: MvpHttpRequest): ObjectValue => {
  const contentType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== JSON_TYPE) throw new RequestProblem(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  const contentLength = header(request, "content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
    throw new RequestProblem(413, "REQUEST_TOO_LARGE", "Request body is too large.");
  }
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new RequestProblem(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }
  return request.body as ObjectValue;
};

const requireObject = (request: MvpHttpRequest, allowed: readonly string[]): ObjectValue => {
  const contentType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== JSON_TYPE) {
    throw new RequestProblem(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  const contentLength = header(request, "content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
    throw new RequestProblem(413, "REQUEST_TOO_LARGE", "Request body is too large.");
  }
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new RequestProblem(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }
  const body = request.body as ObjectValue;
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new RequestProblem(400, "INVALID_REQUEST", "Request contains unsupported fields.");
  }
  return body;
};

const requireIdempotency = (request: MvpHttpRequest): string => {
  const value = header(request, "idempotency-key");
  if (value === undefined) {
    throw new RequestProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.");
  }
  return requireString(value, "Idempotency-Key", 16, 128);
};

const requireRevision = (request: MvpHttpRequest): number => {
  const raw = header(request, "if-match");
  if (raw === undefined) throw new RequestProblem(400, "IF_MATCH_REQUIRED", "If-Match is required.");
  const match = raw.trim().match(/^"?([1-9][0-9]*)"?$/);
  if (match?.[1] === undefined) throw new RequestProblem(400, "INVALID_REQUEST", "If-Match must contain a positive revision.");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new RequestProblem(400, "INVALID_REQUEST", "If-Match revision is invalid.");
  return value;
};

const requireTrace = (request: MvpHttpRequest): string => {
  const value = header(request, "x-trace-id");
  if (value === undefined) {
    throw new RequestProblem(400, "TRACE_ID_REQUIRED", "X-Trace-Id is required.");
  }
  return requireString(value, "X-Trace-Id", 1, 128);
};

const problem = (
  status: number,
  code: string,
  title: string,
  traceId: string,
): MvpHttpResponse => {
  const messageClass: ApiProblem["messageClass"] =
    status === 401 ? "AUTH" :
    status === 403 || status === 404 ? "PERMISSION" :
    status === 400 || status === 413 || status === 415 ? "VALIDATION" :
    status === 409 ? "CONFLICT" :
    status === 429 ? "RATE_LIMIT" :
    status === 501 ? "CAPABILITY" :
    status === 503 ? "AVAILABILITY" : "INTERNAL";
  const retryHint: ApiProblem["retryHint"] =
    status === 409 ? "REFRESH_AND_RETRY" :
    status === 429 ? "RETRY_AFTER" :
    status === 503 || status >= 500 ? "RETRY_SAME_REQUEST" : "DO_NOT_RETRY";
  const body: ApiProblem = {
    type: `urn:companion-social:problem:${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    messageClass,
    retryHint,
    traceId,
  };
  return { status, headers: { "content-type": PROBLEM_TYPE, "x-trace-id": traceId }, body };
};

const requireDateTime = (value: unknown, name: string): string => {
  const text = requireString(value, name, 1, 64);
  if (Number.isNaN(Date.parse(text))) {
    throw new RequestProblem(400, "INVALID_REQUEST", `${name} must be an ISO date-time.`);
  }
  return new Date(text).toISOString();
};

const json = (status: number, body: unknown, traceId: string): MvpHttpResponse => ({
  status,
  headers: { "content-type": JSON_TYPE, "x-trace-id": traceId },
  body,
});

const mapError = (error: unknown, traceId: string): MvpHttpResponse => {
  if (error instanceof RequestProblem) return problem(error.status, error.code, error.title, traceId);
  if (error instanceof ApiAuthenticationError) {
    return problem(401, error.code, "Authentication is required.", traceId);
  }
  if (error instanceof OwnerSessionError) {
    return error.code === "FORBIDDEN"
      ? problem(403, error.code, "This account has no active Owner access.", traceId)
      : problem(503, error.code, "Authentication is temporarily unavailable.", traceId);
  }
  if (error instanceof ImportPolicyError) {
    return problem(400, error.code, "The Companion import is invalid.", traceId);
  }
  if (error instanceof ConflictError) {
    return problem(409, "IMPORT_CONFLICT", "The Companion import conflicts with current state.", traceId);
  }
  if (error instanceof AuthorizationError) {
    return problem(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.", traceId);
  }
  if (error instanceof PostgresPersistenceError) {
    const mapped = {
      NOT_FOUND: [404, "RESOURCE_NOT_FOUND", "The requested resource was not found."],
      INVALID_INPUT: [400, "INVALID_REQUEST", "The request is invalid."],
      CONFLICT: [409, "REQUEST_CONFLICT", "The request conflicts with current state."],
      FORBIDDEN: [403, "FORBIDDEN", "The authenticated Owner cannot perform this action."],
      INVALID_STATE: [409, "INVALID_STATE", "The resource is not in a valid state for this action."],
      DATABASE_UNAVAILABLE: [503, "SERVICE_UNAVAILABLE", "The service is temporarily unavailable."],
      DATABASE_ERROR: [500, "INTERNAL_ERROR", "The request could not be completed."],
    } as const;
    const [status, code, title] = mapped[error.code];
    return problem(status, code, title, traceId);
  }
  return problem(500, "INTERNAL_ERROR", "The request could not be completed.", traceId);
};

const authenticate = async (
  request: MvpHttpRequest,
  resolver: OwnerSessionResolver,
): Promise<AuthenticatedOwnerSession> => {
  const authorization = header(request, "authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (match?.[1] === undefined) throw new ApiAuthenticationError("AUTHENTICATION_REQUIRED");
  return resolver.resolve(match[1]);
};

const invitationBody = (request: MvpHttpRequest) => {
  const body = requireObject(request, [
    "initiatorTwinId",
    "responderTwinId",
    "initiatorSocialPersonaId",
    "responderSocialPersonaId",
    "initiatorIdentityVersionId",
    "responderIdentityVersionId",
    "purpose",
    "scope",
    "contextHash",
    "expiresAt",
  ]);
  const contextHash = requireString(body.contextHash, "contextHash", 64, 64);
  if (!SHA256.test(contextHash)) throw new RequestProblem(400, "INVALID_REQUEST", "contextHash is invalid.");
  if (body.scope !== "ONE_SHOT_ENCOUNTER") {
    throw new RequestProblem(400, "INVALID_REQUEST", "Only ONE_SHOT_ENCOUNTER is supported.");
  }
  return {
    initiatorTwinId: requireUuid(body.initiatorTwinId, "initiatorTwinId"),
    responderTwinId: requireUuid(body.responderTwinId, "responderTwinId"),
    initiatorSocialPersonaId: requireUuid(body.initiatorSocialPersonaId, "initiatorSocialPersonaId"),
    responderSocialPersonaId: requireUuid(body.responderSocialPersonaId, "responderSocialPersonaId"),
    initiatorIdentityVersionId: requireUuid(body.initiatorIdentityVersionId, "initiatorIdentityVersionId"),
    responderIdentityVersionId: requireUuid(body.responderIdentityVersionId, "responderIdentityVersionId"),
    purpose: requireString(body.purpose, "purpose", 1, 500),
    scope: "ONE_SHOT_ENCOUNTER" as const,
    contextHash,
    expiresAt: requireDateTime(body.expiresAt, "expiresAt"),
  };
};

export class MvpApiBoundary {
  readonly #sessions: OwnerSessionResolver;
  readonly #encounters: EncounterCommandPort;
  readonly #id: () => string;

  constructor(input: {
    readonly sessions: OwnerSessionResolver;
    readonly encounters: EncounterCommandPort;
    readonly id?: () => string;
  }) {
    this.#sessions = input.sessions;
    this.#encounters = input.encounters;
    this.#id = input.id ?? randomUUID;
  }

  async handle(request: MvpHttpRequest): Promise<MvpHttpResponse> {
    const fallbackTraceId = header(request, "x-trace-id") ?? this.#id();
    try {
      const url = new URL(request.url, "https://api.companion-social.invalid");
      const pathname = url.pathname.replace(/\/$/, "") || "/";
      const method = request.method.toUpperCase();
      const session = await authenticate(request, this.#sessions);
      const community = await handleCommunityRequest(request, session, fallbackTraceId);
      if (community) return community;

      if (method === "POST" && pathname === "/v0/encounters") {
        const idempotencyKey = requireIdempotency(request);
        const traceId = requireTrace(request);
        const body = requireObject(request, ["invitationId", "message", "maxMemories"]);
        const maxMemories = body.maxMemories;
        if (
          maxMemories !== undefined &&
          (!Number.isSafeInteger(maxMemories) || (maxMemories as number) < 1 || (maxMemories as number) > 20)
        ) {
          throw new RequestProblem(400, "INVALID_REQUEST", "maxMemories must be between 1 and 20.");
        }
        const result = await this.#encounters.run({
          actorOwnerId: session.ownerId,
          invitationId: requireUuid(body.invitationId, "invitationId"),
          encounterId: this.#id(),
          message: requireString(body.message, "message", 1, 2_000),
          ...(maxMemories === undefined ? {} : { maxMemories: maxMemories as number }),
          idempotencyKey,
          traceId,
        });
        return json(
          200,
          {
            encounterId: result.encounterId,
            status: result.status,
            ...(result.outcomeCode === undefined ? {} : { outcomeCode: result.outcomeCode }),
            replayed: result.replayed,
          },
          traceId,
        );
      }

      if (pathname === "/v0/encounter-invitations" && method === "POST") {
        const idempotencyKey = requireIdempotency(request);
        const body = invitationBody(request);
        const result = await session.owner.issueInvitation({
          ...body,
          idempotencyKeyHash: hash(`invitation:${session.ownerId}:${idempotencyKey}`),
          requestHash: hash(body),
        });
        return json(result.replayed ? 200 : 201, result, fallbackTraceId);
      }

      if (pathname === "/v0/encounter-invitations" && method === "GET") {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 20 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw new RequestProblem(400, "INVALID_REQUEST", "limit must be between 1 and 50.");
        }
        const beforeCreatedAt = url.searchParams.get("beforeCreatedAt") ?? undefined;
        const beforeInvitationId = url.searchParams.get("beforeInvitationId") ?? undefined;
        if ((beforeCreatedAt === undefined) !== (beforeInvitationId === undefined)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "Both cursor fields are required together.");
        }
        const before = beforeCreatedAt === undefined
          ? undefined
          : {
              createdAt: requireDateTime(beforeCreatedAt, "beforeCreatedAt"),
              invitationId: requireUuid(beforeInvitationId, "beforeInvitationId"),
            };
        const items = await session.owner.listInvitations(limit, before);
        const last = items.at(-1);
        return json(
          200,
          {
            items,
            nextCursor:
              items.length === limit && last !== undefined
                ? { beforeCreatedAt: last.createdAt, beforeInvitationId: last.invitationId }
                : null,
          },
          fallbackTraceId,
        );
      }

      const decision = pathname.match(/^\/v0\/encounter-invitations\/([^/]+)\/(approve|reject)$/);
      if (method === "POST" && decision?.[1] !== undefined && decision[2] !== undefined) {
        const idempotencyKey = requireIdempotency(request);
        const invitationId = requireUuid(decision[1], "invitationId");
        const idempotencyHash = hash(`${decision[2]}:${session.ownerId}:${idempotencyKey}`);
        const requestHash = hash({ invitationId, decision: decision[2] });
        const result = decision[2] === "approve"
          ? await session.owner.approveInvitation(invitationId, idempotencyHash, requestHash)
          : await session.owner.rejectInvitation(invitationId, idempotencyHash, requestHash);
        return json(200, result, fallbackTraceId);
      }


      if (method === "GET" && pathname === "/v0/identity-context") {
        const kindRaw = url.searchParams.get("activeSubjectKind");
        const idRaw = url.searchParams.get("activeSubjectId");
        if ((kindRaw === null) !== (idRaw === null)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "activeSubjectKind and activeSubjectId must be provided together.");
        }
        if (kindRaw !== null && !["OWNER", "COMPANION", "SOCIAL_TWIN"].includes(kindRaw)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "activeSubjectKind is invalid.");
        }
        const result = await session.owner.getIdentityContext(
          kindRaw === null ? undefined : {
            activeSubjectKind: kindRaw as "OWNER" | "COMPANION" | "SOCIAL_TWIN",
            activeSubjectId: requireUuid(idRaw, "activeSubjectId"),
          },
        );
        return json(200, result, fallbackTraceId);
      }

      if (method === "GET" && pathname === "/v0/companions") {
        return json(200, { items: await session.owner.listOwnerCompanions() }, fallbackTraceId);
      }

      if (method === "GET" && pathname === "/v0/world-items") {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 20 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw new RequestProblem(400, "INVALID_REQUEST", "limit must be between 1 and 50.");
        }
        const beforeRaw = url.searchParams.get("beforeCreatedAt");
        const beforeCreatedAt = beforeRaw === null ? undefined : requireDateTime(beforeRaw, "beforeCreatedAt");
        return json(200, await session.owner.listWorldItems(limit, beforeCreatedAt), fallbackTraceId);
      }

      const socialPersona = pathname.match(/^\/v0\/companions\/([^/]+)\/social-persona$/);
      if (method === "PUT" && socialPersona?.[1] !== undefined) {
        const companionId = requireUuid(socialPersona[1], "companionId");
        const idempotencyKey = requireIdempotency(request);
        const body = requireObject(request, [
          "sourceIdentityVersionId",
          "handle",
          "profileVisibility",
          "autonomyMode",
          "selections",
        ]);
        const sourceIdentityVersionId = requireUuid(body.sourceIdentityVersionId, "sourceIdentityVersionId");
        const handleValue = requireString(body.handle, "handle", 3, 30).trim().toLowerCase();
        if (!/^[a-z0-9_]{3,30}$/.test(handleValue)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "handle is invalid.");
        }
        if (!["PRIVATE", "FRIENDS", "PUBLIC"].includes(String(body.profileVisibility))) {
          throw new RequestProblem(400, "INVALID_REQUEST", "profileVisibility is invalid.");
        }
        if (!["QUIET", "NORMAL", "ACTIVE", "CUSTOM"].includes(String(body.autonomyMode))) {
          throw new RequestProblem(400, "INVALID_REQUEST", "autonomyMode is invalid.");
        }
        if (!Array.isArray(body.selections) || body.selections.length < 1) {
          throw new RequestProblem(400, "INVALID_REQUEST", "selections must be a non-empty array.");
        }
        const allowed = new Map([
          ["displayName", "displayName"],
          ["identitySummary", "bio"],
          ["personaTraits", "publicTraits"],
          ["speakingStyle", "publicVoice"],
          ["values", "publicInterests"],
          ["boundaries", "publicBoundaries"],
        ]);
        const selections = body.selections.map((entry) => {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new RequestProblem(400, "INVALID_REQUEST", "projection selection is invalid.");
          }
          const row = entry as Record<string, unknown>;
          if (Object.keys(row).some((key) => key !== "sourceField" && key !== "targetField")) {
            throw new RequestProblem(400, "INVALID_REQUEST", "projection selection contains unsupported fields.");
          }
          const sourceField = String(row.sourceField ?? "");
          const targetField = String(row.targetField ?? "");
          if (allowed.get(sourceField) !== targetField) {
            throw new RequestProblem(400, "INVALID_REQUEST", "projection mapping is not allowlisted.");
          }
          return { sourceField, targetField } as import("./types.ts").ProjectionSelectionInput;
        });
        if (!selections.some((entry) => entry.sourceField === "displayName" && entry.targetField === "displayName")) {
          throw new RequestProblem(400, "INVALID_REQUEST", "displayName projection is required.");
        }
        if (new Set(selections.map((entry) => entry.targetField)).size !== selections.length) {
          throw new RequestProblem(400, "INVALID_REQUEST", "projection target fields must be unique.");
        }

        const requestHash = hash({
          companionId,
          sourceIdentityVersionId,
          handle: handleValue,
          profileVisibility: body.profileVisibility,
          autonomyMode: body.autonomyMode,
          selections,
        });
        const result = await session.owner.projectAndActivateSocialTwin({
          companionId,
          sourceIdentityVersionId,
          handle: handleValue,
          profileVisibility: body.profileVisibility as "PRIVATE" | "FRIENDS" | "PUBLIC",
          autonomyMode: body.autonomyMode as "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM",
          selections,
          idempotencyKeyHash: hash(`social-projection:${session.ownerId}:${idempotencyKey}`),
          requestHash,
        });
        return json(200, result, fallbackTraceId);
      }

      const profile = pathname.match(/^\/v0\/companions\/([^/]+)\/profile$/);
      if (method === "GET" && profile?.[1] !== undefined) {
        const kindRaw = url.searchParams.get("activeSubjectKind");
        const idRaw = url.searchParams.get("activeSubjectId");
        if (kindRaw !== null && !["OWNER", "COMPANION", "SOCIAL_TWIN"].includes(kindRaw)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "activeSubjectKind is invalid.");
        }
        if (kindRaw === "OWNER" && idRaw !== null) {
          throw new RequestProblem(400, "INVALID_REQUEST", "OWNER profile view does not accept activeSubjectId.");
        }
        if ((kindRaw === "COMPANION" || kindRaw === "SOCIAL_TWIN") && idRaw === null) {
          throw new RequestProblem(400, "INVALID_REQUEST", "activeSubjectId is required for Companion or Social Twin profile views.");
        }
        const viewer = kindRaw === null
          ? undefined
          : {
              activeSubjectKind: kindRaw as "OWNER" | "COMPANION" | "SOCIAL_TWIN",
              ...(idRaw === null ? {} : { activeSubjectId: requireUuid(idRaw, "activeSubjectId") }),
            };
        const result = await session.owner.getCompanionProfile(
          requireUuid(profile[1], "companionId"),
          viewer,
        );
        return result === undefined
          ? problem(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.", fallbackTraceId)
          : json(200, result, fallbackTraceId);
      }

      const detail = pathname.match(/^\/v0\/encounters\/([^/]+)$/);
      if (method === "GET" && detail?.[1] !== undefined) {
        const result = await session.owner.getEncounterDetail(requireUuid(detail[1], "encounterId"));
        return result === undefined
          ? problem(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.", fallbackTraceId)
          : json(200, result, fallbackTraceId);
      }


      if (method === "GET" && pathname === "/v0/life-continuity") {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 30 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw new RequestProblem(400, "INVALID_REQUEST", "limit must be between 1 and 50.");
        }
        const kindRaw = url.searchParams.get("activeSubjectKind");
        const idRaw = url.searchParams.get("activeSubjectId");
        if (kindRaw !== null && !["OWNER", "COMPANION", "SOCIAL_TWIN"].includes(kindRaw)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "activeSubjectKind is invalid.");
        }
        if (kindRaw === "OWNER" && idRaw !== null) {
          throw new RequestProblem(400, "INVALID_REQUEST", "OWNER Life view does not accept activeSubjectId.");
        }
        if ((kindRaw === "COMPANION" || kindRaw === "SOCIAL_TWIN") && idRaw === null) {
          throw new RequestProblem(400, "INVALID_REQUEST", "activeSubjectId is required for Companion or Social Twin Life views.");
        }
        const viewer = kindRaw === null
          ? undefined
          : {
              activeSubjectKind: kindRaw as "OWNER" | "COMPANION" | "SOCIAL_TWIN",
              ...(idRaw === null ? {} : { activeSubjectId: requireUuid(idRaw, "activeSubjectId") }),
            };
        const beforeOccurredAtRaw = url.searchParams.get("beforeOccurredAt");
        const beforeIdRaw = url.searchParams.get("beforeId");
        if ((beforeOccurredAtRaw === null) !== (beforeIdRaw === null)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "Both Life continuity cursor fields are required together.");
        }
        const before = beforeOccurredAtRaw === null ? undefined : {
          occurredAt: requireDateTime(beforeOccurredAtRaw, "beforeOccurredAt"),
          id: requireUuid(beforeIdRaw, "beforeId"),
        };
        return json(200, await session.owner.listLifeContinuity(limit, viewer, before), fallbackTraceId);
      }

      if (method === "GET" && pathname === "/v0/life-event-inbox") {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 20 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw new RequestProblem(400, "INVALID_REQUEST", "limit must be between 1 and 50.");
        }
        const beforeCreatedAtRaw = url.searchParams.get("beforeCreatedAt");
        const beforeIdRaw = url.searchParams.get("beforeId");
        if ((beforeCreatedAtRaw === null) !== (beforeIdRaw === null)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "Both Life Event cursor fields are required together.");
        }
        const before = beforeCreatedAtRaw === null ? undefined : {
          createdAt: requireDateTime(beforeCreatedAtRaw, "beforeCreatedAt"),
          id: requireUuid(beforeIdRaw, "beforeId"),
        };
        return json(200, await session.owner.listLifeEventInbox(limit, before), fallbackTraceId);
      }

      const lifeAck = pathname.match(/^\/v0\/life-event-inbox\/([^/]+)\/read$/);
      if (method === "PUT" && lifeAck?.[1] !== undefined) {
        const result = await session.owner.acknowledgeLifeEvent(requireUuid(lifeAck[1], "itemId"));
        return result === undefined
          ? problem(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.", fallbackTraceId)
          : json(200, result, fallbackTraceId);
      }



      if (pathname === "/v0/companion-imports" && method === "POST") {
        const idempotencyKey = requireIdempotency(request);
        const body = requireAnyObject(request);
        const rawPayload = canonicalJson(body);
        const bytes = new TextEncoder().encode(rawPayload);
        const parsed = parseCharacterCard(bytes);
        const originalSha256 = sha256(bytes);
        const idempotencyKeyHash = hash(`companion-import:${session.ownerId}:${idempotencyKey}`);
        const requestHash = hash({ originalSha256, sourceFormat: parsed.sourceFormat });
        const result = await session.owner.createCompanionImport({
          rawPayload,
          originalSha256,
          byteLength: bytes.byteLength,
          parserVersion: parserMetadata.parserVersion,
          policyVersion: parserMetadata.policyVersion,
          sourceFormat: parsed.sourceFormat,
          draft: parsed.draft,
          findings: parsed.findings,
          idempotencyKeyHash,
          requestHash,
        });
        return json(201, result, fallbackTraceId);
      }

      const importReview = pathname.match(/^\/v0\/companion-imports\/([^/]+)$/);
      if (method === "GET" && importReview?.[1] !== undefined) {
        const result = await session.owner.getCompanionImportReview(requireUuid(importReview[1], "importId"));
        return result === undefined
          ? problem(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.", fallbackTraceId)
          : json(200, result, fallbackTraceId);
      }

      const importApproval = pathname.match(/^\/v0\/companion-imports\/([^/]+)\/approve$/);
      if (method === "POST" && importApproval?.[1] !== undefined) {
        const importId = requireUuid(importApproval[1], "importId");
        const idempotencyKey = requireIdempotency(request);
        const body = requireObject(request, ["approvedCandidateIds", "companionId"]);
        if (!Array.isArray(body.approvedCandidateIds) || body.approvedCandidateIds.length < 1 || !body.approvedCandidateIds.every((value) => typeof value === "string" && value.length > 0)) {
          throw new RequestProblem(400, "INVALID_REQUEST", "approvedCandidateIds must be a non-empty string array.");
        }
        const approvedCandidateIds = body.approvedCandidateIds as string[];
        if (new Set(approvedCandidateIds).size !== approvedCandidateIds.length) {
          throw new RequestProblem(400, "INVALID_REQUEST", "approvedCandidateIds must be unique.");
        }
        const companionId = body.companionId === undefined ? undefined : requireUuid(body.companionId, "companionId");
        const idempotencyKeyHash = hash(`companion-import-approve:${session.ownerId}:${idempotencyKey}`);
        const requestHash = hash({ importId, approvedCandidateIds: [...approvedCandidateIds].sort(), companionId: companionId ?? null });
        const result = await session.owner.approveCompanionImport({ importId, approvedCandidateIds, ...(companionId === undefined ? {} : { companionId }), idempotencyKeyHash, requestHash });
        return json(201, result, fallbackTraceId);
      }

      if (pathname === "/v0/controls" && method === "GET") {
        const companionIdRaw = url.searchParams.get("companionId");
        if (companionIdRaw === null) throw new RequestProblem(400, "INVALID_REQUEST", "companionId is required.");
        const result = await session.owner.getControls(requireUuid(companionIdRaw, "companionId"));
        return result === undefined
          ? problem(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.", fallbackTraceId)
          : json(200, result, fallbackTraceId);
      }

      if (pathname === "/v0/controls" && method === "PATCH") {
        const companionIdRaw = url.searchParams.get("companionId");
        if (companionIdRaw === null) throw new RequestProblem(400, "INVALID_REQUEST", "companionId is required.");
        const companionId = requireUuid(companionIdRaw, "companionId");
        const ifMatch = requireRevision(request);
        const idempotencyKey = requireIdempotency(request);
        const body = requireObject(request, ["socialTwinVisibility", "socialAutonomyMode", "memorySharingScope", "notificationsEnabled"]);
        if (Object.keys(body).length === 0) throw new RequestProblem(400, "INVALID_REQUEST", "At least one supported control is required.");
        if (body.socialTwinVisibility !== undefined && !["PRIVATE", "FRIENDS", "PUBLIC"].includes(String(body.socialTwinVisibility))) {
          throw new RequestProblem(400, "INVALID_REQUEST", "socialTwinVisibility is invalid.");
        }
        if (body.socialAutonomyMode !== undefined && !["QUIET", "NORMAL", "ACTIVE", "CUSTOM"].includes(String(body.socialAutonomyMode))) {
          throw new RequestProblem(400, "INVALID_REQUEST", "socialAutonomyMode is invalid.");
        }
        if (body.memorySharingScope !== undefined && body.memorySharingScope !== "PERMISSION_GATED_SOCIAL_ONLY") {
          throw new RequestProblem(400, "INVALID_REQUEST", "memorySharingScope is not supported.");
        }
        if (body.notificationsEnabled !== undefined && typeof body.notificationsEnabled !== "boolean") {
          throw new RequestProblem(400, "INVALID_REQUEST", "notificationsEnabled must be boolean.");
        }
        const patch = body as import("./types.ts").ControlsPatchInput;
        const result = await session.owner.updateControls({
          companionId,
          ifMatch,
          patch,
          idempotencyKeyHash: hash(`controls:${session.ownerId}:${idempotencyKey}`),
          requestHash: hash({ companionId, ifMatch, patch }),
        });
        return result === undefined
          ? problem(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.", fallbackTraceId)
          : json(200, result, fallbackTraceId);
      }

      const receipt = pathname.match(/^\/v0\/compute-receipts\/([^/]+)$/);
      if (method === "GET" && receipt?.[1] !== undefined) {
        const result = await session.owner.getComputeReceipt(requireUuid(receipt[1], "transactionId"));
        return result === undefined
          ? problem(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.", fallbackTraceId)
          : json(200, result, fallbackTraceId);
      }


      return problem(404, "ROUTE_NOT_FOUND", "The requested API route was not found.", fallbackTraceId);
    } catch (error) {
      return mapError(error, fallbackTraceId);
    }
  }
}

export const createProductionMvpApiBoundary = (input: {
  readonly sessions: OwnerSessionResolver;
  readonly encounters: PersistentEncounterOrchestrator;
  readonly id?: () => string;
}): MvpApiBoundary => new MvpApiBoundary(input);
