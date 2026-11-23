import { randomUUID } from "node:crypto";
import { handleChatRequest } from "../chat/http.ts";
import { ChatReplies } from "../chat/replies.ts";
import { handleCommunityRequest } from "../community/http.ts";
import { canonicalJson, contentHash, sha256 } from "../companion-import/canonical.ts";
import { parseCharacterCard, parserMetadata } from "../companion-import/parser.ts";
import { ImportPolicyError } from "../companion-import/errors.ts";
import { PostgresPersistenceError } from "../persistence/postgres/types.ts";
import {
  ApiAuthenticationError,
  OwnerSessionError,
  type ApiProblem,
  type AuthenticatedOwnerSession,
  type ControlsPatchInput,
  type EncounterCommandPort,
  type MvpHttpRequest,
  type MvpHttpResponse,
  type OwnerSessionResolver,
  type ProjectionSelectionInput,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const JSON_TYPE = "application/json";
const PROBLEM_TYPE = "application/problem+json";
const SUBJECT_KINDS = ["OWNER", "COMPANION", "SOCIAL_TWIN"] as const;
const VISIBILITIES = ["PRIVATE", "FRIENDS", "PUBLIC"] as const;
const AUTONOMY_MODES = ["QUIET", "NORMAL", "ACTIVE", "CUSTOM"] as const;
const NOT_FOUND = [404, "RESOURCE_NOT_FOUND", "The requested resource was not found."] as const;
const PROJECTION_TARGETS = new Map([
  ["displayName", "displayName"],
  ["identitySummary", "bio"],
  ["personaTraits", "publicTraits"],
  ["speakingStyle", "publicVoice"],
  ["values", "publicInterests"],
  ["boundaries", "publicBoundaries"],
]);

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

const invalid = (title: string): RequestProblem => new RequestProblem(400, "INVALID_REQUEST", title);

const header = (request: MvpHttpRequest, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

const requireUuid = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${name} must be a UUID.`);
  return value;
};

const requireString = (value: unknown, name: string, minimum: number, maximum: number): string => {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw invalid(`${name} is invalid.`);
  }
  return value;
};

const requireDateTime = (value: unknown, name: string): string => {
  const text = requireString(value, name, 1, 64);
  if (Number.isNaN(Date.parse(text))) throw invalid(`${name} must be an ISO date-time.`);
  return new Date(text).toISOString();
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], name: string): T => {
  if (!allowed.includes(value as T)) throw invalid(`${name} is invalid.`);
  return value as T;
};

const requireAnyObject = (request: MvpHttpRequest): ObjectValue => {
  const contentType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== JSON_TYPE) {
    throw new RequestProblem(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw invalid("Request body must be a JSON object.");
  }
  return request.body as ObjectValue;
};

const requireObject = (request: MvpHttpRequest, allowed: readonly string[]): ObjectValue => {
  const body = requireAnyObject(request);
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw invalid("Request contains unsupported fields.");
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
  if (match?.[1] === undefined) throw invalid("If-Match must contain a positive revision.");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw invalid("If-Match revision is invalid.");
  return value;
};

const requireTrace = (request: MvpHttpRequest): string => {
  const value = header(request, "x-trace-id");
  if (value === undefined) {
    throw new RequestProblem(400, "TRACE_ID_REQUIRED", "X-Trace-Id is required.");
  }
  return requireString(value, "X-Trace-Id", 1, 128);
};

const limitParam = (query: URLSearchParams, fallback: number): number => {
  const raw = query.get("limit");
  const limit = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw invalid("limit must be between 1 and 50.");
  }
  return limit;
};

const cursorParam = (query: URLSearchParams, atName: string, idName: string, label: string) => {
  const at = query.get(atName);
  const id = query.get(idName);
  if ((at === null) !== (id === null)) throw invalid(`Both ${label}cursor fields are required together.`);
  return at === null ? undefined : { at: requireDateTime(at, atName), id: requireUuid(id, idName) };
};

const viewerParam = (query: URLSearchParams, label: string) => {
  const kind = query.get("activeSubjectKind");
  const id = query.get("activeSubjectId");
  if (kind === null) return undefined;
  const activeSubjectKind = oneOf(kind, SUBJECT_KINDS, "activeSubjectKind");
  if (activeSubjectKind === "OWNER" && id !== null) {
    throw invalid(`OWNER ${label} view does not accept activeSubjectId.`);
  }
  if (activeSubjectKind !== "OWNER" && id === null) {
    throw invalid(`activeSubjectId is required for Companion or Social Twin ${label} views.`);
  }
  return { activeSubjectKind, ...(id === null ? {} : { activeSubjectId: requireUuid(id, "activeSubjectId") }) };
};

const companionIdParam = (query: URLSearchParams): string => {
  const raw = query.get("companionId");
  if (raw === null) throw invalid("companionId is required.");
  return requireUuid(raw, "companionId");
};

const PROBLEM_CLASS: Readonly<Record<number, readonly [ApiProblem["messageClass"], ApiProblem["retryHint"]]>> = {
  400: ["VALIDATION", "DO_NOT_RETRY"],
  401: ["AUTH", "DO_NOT_RETRY"],
  403: ["PERMISSION", "DO_NOT_RETRY"],
  404: ["PERMISSION", "DO_NOT_RETRY"],
  409: ["CONFLICT", "REFRESH_AND_RETRY"],
  415: ["VALIDATION", "DO_NOT_RETRY"],
  503: ["AVAILABILITY", "RETRY_SAME_REQUEST"],
};

const problem = (status: number, code: string, title: string, traceId: string): MvpHttpResponse => {
  const [messageClass, retryHint] = PROBLEM_CLASS[status] ?? ["INTERNAL", "RETRY_SAME_REQUEST"];
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
  if (error instanceof PostgresPersistenceError) {
    const mapped = {
      NOT_FOUND,
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
  const match = header(request, "authorization")?.match(/^Bearer ([^\s]+)$/);
  if (match?.[1] === undefined) throw new ApiAuthenticationError("AUTHENTICATION_REQUIRED");
  return resolver.resolve(match[1]);
};

interface RouteContext {
  readonly request: MvpHttpRequest;
  readonly query: URLSearchParams;
  readonly params: readonly (string | undefined)[];
  readonly session: AuthenticatedOwnerSession;
  readonly encounters: EncounterCommandPort;
  readonly id: () => string;
}

/** A handler returns [status, body]; an undefined body means the resource was not found. */
type Handler = (context: RouteContext) => Promise<readonly [status: number, body: unknown]>;

const idempotencyHash = ({ request, session }: RouteContext, scope: string): string =>
  sha256(`${scope}:${session.ownerId}:${requireIdempotency(request)}`);

const runEncounter: Handler = async ({ request, session, encounters, id }) => {
  const idempotencyKey = requireIdempotency(request);
  const traceId = requireTrace(request);
  const body = requireObject(request, ["invitationId", "message", "maxMemories"]);
  const maxMemories = body.maxMemories;
  if (
    maxMemories !== undefined &&
    (!Number.isSafeInteger(maxMemories) || (maxMemories as number) < 1 || (maxMemories as number) > 20)
  ) {
    throw invalid("maxMemories must be between 1 and 20.");
  }
  const result = await encounters.run({
    actorOwnerId: session.ownerId,
    invitationId: requireUuid(body.invitationId, "invitationId"),
    encounterId: id(),
    message: requireString(body.message, "message", 1, 2_000),
    ...(maxMemories === undefined ? {} : { maxMemories: maxMemories as number }),
    idempotencyKey,
    traceId,
  });
  return [200, {
    encounterId: result.encounterId,
    status: result.status,
    ...(result.outcomeCode === undefined ? {} : { outcomeCode: result.outcomeCode }),
    replayed: result.replayed,
  }];
};

const issueInvitation: Handler = async (context) => {
  const idempotencyKeyHash = idempotencyHash(context, "invitation");
  const body = requireObject(context.request, [
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
  if (!SHA256.test(contextHash)) throw invalid("contextHash is invalid.");
  if (body.scope !== "ONE_SHOT_ENCOUNTER") throw invalid("Only ONE_SHOT_ENCOUNTER is supported.");
  const invitation = {
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
  const result = await context.session.owner.issueInvitation({
    ...invitation,
    idempotencyKeyHash,
    requestHash: contentHash(invitation),
  });
  return [result.replayed ? 200 : 201, result];
};

const listInvitations: Handler = async ({ query, session }) => {
  const limit = limitParam(query, 20);
  const before = cursorParam(query, "beforeCreatedAt", "beforeInvitationId", "");
  const items = await session.owner.listInvitations(
    limit,
    before && { createdAt: before.at, invitationId: before.id },
  );
  const last = items.at(-1);
  const nextCursor = items.length === limit && last !== undefined
    ? { beforeCreatedAt: last.createdAt, beforeInvitationId: last.invitationId }
    : null;
  return [200, { items, nextCursor }];
};

const decideInvitation: Handler = async (context) => {
  const decision = context.params[1] === "approve" ? "approve" : "reject";
  const idempotencyKeyHash = idempotencyHash(context, decision);
  const invitationId = requireUuid(context.params[0], "invitationId");
  const requestHash = contentHash({ invitationId, decision });
  const { owner } = context.session;
  return [200, decision === "approve"
    ? await owner.approveInvitation(invitationId, idempotencyKeyHash, requestHash)
    : await owner.rejectInvitation(invitationId, idempotencyKeyHash, requestHash)];
};

const getIdentityContext: Handler = async ({ query, session }) => {
  const kind = query.get("activeSubjectKind");
  const id = query.get("activeSubjectId");
  if ((kind === null) !== (id === null)) {
    throw invalid("activeSubjectKind and activeSubjectId must be provided together.");
  }
  const subject = kind === null ? undefined : {
    activeSubjectKind: oneOf(kind, SUBJECT_KINDS, "activeSubjectKind"),
    activeSubjectId: requireUuid(id, "activeSubjectId"),
  };
  return [200, await session.owner.getIdentityContext(subject)];
};

const listOwnerCompanions: Handler = async ({ session }) =>
  [200, { items: await session.owner.listOwnerCompanions() }];

const listWorldItems: Handler = async ({ query, session }) => {
  const limit = limitParam(query, 20);
  const before = query.get("beforeCreatedAt");
  const beforeCreatedAt = before === null ? undefined : requireDateTime(before, "beforeCreatedAt");
  return [200, await session.owner.listWorldItems(limit, beforeCreatedAt)];
};

const projectionSelection = (entry: unknown): ProjectionSelectionInput => {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw invalid("projection selection is invalid.");
  }
  const row = entry as ObjectValue;
  if (Object.keys(row).some((key) => key !== "sourceField" && key !== "targetField")) {
    throw invalid("projection selection contains unsupported fields.");
  }
  const sourceField = String(row.sourceField ?? "");
  const targetField = String(row.targetField ?? "");
  if (PROJECTION_TARGETS.get(sourceField) !== targetField) {
    throw invalid("projection mapping is not allowlisted.");
  }
  return { sourceField, targetField } as ProjectionSelectionInput;
};

const projectSocialPersona: Handler = async (context) => {
  const companionId = requireUuid(context.params[0], "companionId");
  const idempotencyKeyHash = idempotencyHash(context, "social-projection");
  const body = requireObject(context.request, [
    "sourceIdentityVersionId",
    "handle",
    "profileVisibility",
    "autonomyMode",
    "selections",
  ]);
  const sourceIdentityVersionId = requireUuid(body.sourceIdentityVersionId, "sourceIdentityVersionId");
  const handle = requireString(body.handle, "handle", 3, 30).trim().toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(handle)) throw invalid("handle is invalid.");
  const profileVisibility = oneOf(body.profileVisibility, VISIBILITIES, "profileVisibility");
  const autonomyMode = oneOf(body.autonomyMode, AUTONOMY_MODES, "autonomyMode");
  if (!Array.isArray(body.selections) || body.selections.length < 1) {
    throw invalid("selections must be a non-empty array.");
  }
  const selections = body.selections.map(projectionSelection);
  if (!selections.some((entry) => entry.sourceField === "displayName")) {
    throw invalid("displayName projection is required.");
  }
  if (new Set(selections.map((entry) => entry.targetField)).size !== selections.length) {
    throw invalid("projection target fields must be unique.");
  }
  const projection = { companionId, sourceIdentityVersionId, handle, profileVisibility, autonomyMode, selections };
  return [200, await context.session.owner.projectAndActivateSocialTwin({
    ...projection,
    idempotencyKeyHash,
    requestHash: contentHash(projection),
  })];
};

const getCompanionProfile: Handler = async ({ query, params, session }) => {
  const viewer = viewerParam(query, "profile");
  return [200, await session.owner.getCompanionProfile(requireUuid(params[0], "companionId"), viewer)];
};

const getEncounterDetail: Handler = async ({ params, session }) =>
  [200, await session.owner.getEncounterDetail(requireUuid(params[0], "encounterId"))];

const listLifeContinuity: Handler = async ({ query, session }) => {
  const limit = limitParam(query, 30);
  const viewer = viewerParam(query, "Life");
  const before = cursorParam(query, "beforeOccurredAt", "beforeId", "Life continuity ");
  return [200, await session.owner.listLifeContinuity(
    limit,
    viewer,
    before && { occurredAt: before.at, id: before.id },
  )];
};

const listLifeEventInbox: Handler = async ({ query, session }) => {
  const limit = limitParam(query, 20);
  const before = cursorParam(query, "beforeCreatedAt", "beforeId", "Life Event ");
  return [200, await session.owner.listLifeEventInbox(limit, before && { createdAt: before.at, id: before.id })];
};

const acknowledgeLifeEvent: Handler = async ({ params, session }) =>
  [200, await session.owner.acknowledgeLifeEvent(requireUuid(params[0], "itemId"))];

const createCompanionImport: Handler = async (context) => {
  const idempotencyKeyHash = idempotencyHash(context, "companion-import");
  const rawPayload = canonicalJson(requireAnyObject(context.request));
  const bytes = new TextEncoder().encode(rawPayload);
  const parsed = parseCharacterCard(bytes);
  const originalSha256 = sha256(bytes);
  return [201, await context.session.owner.createCompanionImport({
    rawPayload,
    originalSha256,
    byteLength: bytes.byteLength,
    parserVersion: parserMetadata.parserVersion,
    policyVersion: parserMetadata.policyVersion,
    sourceFormat: parsed.sourceFormat,
    draft: parsed.draft,
    findings: parsed.findings,
    idempotencyKeyHash,
    requestHash: contentHash({ originalSha256, sourceFormat: parsed.sourceFormat }),
  })];
};

const getCompanionImportReview: Handler = async ({ params, session }) =>
  [200, await session.owner.getCompanionImportReview(requireUuid(params[0], "importId"))];

const approveCompanionImport: Handler = async (context) => {
  const importId = requireUuid(context.params[0], "importId");
  const idempotencyKeyHash = idempotencyHash(context, "companion-import-approve");
  const body = requireObject(context.request, ["approvedCandidateIds", "companionId"]);
  const ids = body.approvedCandidateIds;
  if (!Array.isArray(ids) || ids.length < 1 || !ids.every((value) => typeof value === "string" && value.length > 0)) {
    throw invalid("approvedCandidateIds must be a non-empty string array.");
  }
  const approvedCandidateIds = ids as string[];
  if (new Set(approvedCandidateIds).size !== approvedCandidateIds.length) {
    throw invalid("approvedCandidateIds must be unique.");
  }
  const companionId = body.companionId === undefined ? undefined : requireUuid(body.companionId, "companionId");
  return [201, await context.session.owner.approveCompanionImport({
    importId,
    approvedCandidateIds,
    ...(companionId === undefined ? {} : { companionId }),
    idempotencyKeyHash,
    requestHash: contentHash({
      importId,
      approvedCandidateIds: [...approvedCandidateIds].sort(),
      companionId: companionId ?? null,
    }),
  })];
};

const getControls: Handler = async ({ query, session }) =>
  [200, await session.owner.getControls(companionIdParam(query))];

const updateControls: Handler = async (context) => {
  const companionId = companionIdParam(context.query);
  const ifMatch = requireRevision(context.request);
  const idempotencyKeyHash = idempotencyHash(context, "controls");
  const body = requireObject(context.request, [
    "socialTwinVisibility",
    "socialAutonomyMode",
    "memorySharingScope",
    "notificationsEnabled",
  ]);
  if (Object.keys(body).length === 0) throw invalid("At least one supported control is required.");
  if (body.socialTwinVisibility !== undefined) oneOf(body.socialTwinVisibility, VISIBILITIES, "socialTwinVisibility");
  if (body.socialAutonomyMode !== undefined) oneOf(body.socialAutonomyMode, AUTONOMY_MODES, "socialAutonomyMode");
  if (body.memorySharingScope !== undefined && body.memorySharingScope !== "PERMISSION_GATED_SOCIAL_ONLY") {
    throw invalid("memorySharingScope is not supported.");
  }
  if (body.notificationsEnabled !== undefined && typeof body.notificationsEnabled !== "boolean") {
    throw invalid("notificationsEnabled must be boolean.");
  }
  const patch = body as ControlsPatchInput;
  return [200, await context.session.owner.updateControls({
    companionId,
    ifMatch,
    patch,
    idempotencyKeyHash,
    requestHash: contentHash({ companionId, ifMatch, patch }),
  })];
};

const getComputeReceipt: Handler = async ({ params, session }) =>
  [200, await session.owner.getComputeReceipt(requireUuid(params[0], "transactionId"))];

const ROUTES: readonly (readonly [method: string, path: RegExp, handler: Handler])[] = [
  ["POST", /^\/v0\/encounters$/, runEncounter],
  ["GET", /^\/v0\/encounters\/([^/]+)$/, getEncounterDetail],
  ["POST", /^\/v0\/encounter-invitations$/, issueInvitation],
  ["GET", /^\/v0\/encounter-invitations$/, listInvitations],
  ["POST", /^\/v0\/encounter-invitations\/([^/]+)\/(approve|reject)$/, decideInvitation],
  ["GET", /^\/v0\/identity-context$/, getIdentityContext],
  ["GET", /^\/v0\/world-items$/, listWorldItems],
  ["GET", /^\/v0\/companions$/, listOwnerCompanions],
  ["PUT", /^\/v0\/companions\/([^/]+)\/social-persona$/, projectSocialPersona],
  ["GET", /^\/v0\/companions\/([^/]+)\/profile$/, getCompanionProfile],
  ["GET", /^\/v0\/life-continuity$/, listLifeContinuity],
  ["GET", /^\/v0\/life-event-inbox$/, listLifeEventInbox],
  ["PUT", /^\/v0\/life-event-inbox\/([^/]+)\/read$/, acknowledgeLifeEvent],
  ["POST", /^\/v0\/companion-imports$/, createCompanionImport],
  ["GET", /^\/v0\/companion-imports\/([^/]+)$/, getCompanionImportReview],
  ["POST", /^\/v0\/companion-imports\/([^/]+)\/approve$/, approveCompanionImport],
  ["GET", /^\/v0\/controls$/, getControls],
  ["PATCH", /^\/v0\/controls$/, updateControls],
  ["GET", /^\/v0\/compute-receipts\/([^/]+)$/, getComputeReceipt],
];

export class MvpApiBoundary {
  readonly #sessions: OwnerSessionResolver;
  readonly #encounters: EncounterCommandPort;
  readonly #id: () => string;
  readonly #replies: ChatReplies;

  constructor(input: {
    readonly sessions: OwnerSessionResolver;
    readonly encounters: EncounterCommandPort;
    readonly id?: () => string;
    /** Writes Companion chat replies; without one, replies end as UNAVAILABLE. */
    readonly replies?: ChatReplies;
  }) {
    this.#sessions = input.sessions;
    this.#encounters = input.encounters;
    this.#id = input.id ?? randomUUID;
    this.#replies = input.replies ?? new ChatReplies();
  }

  async handle(request: MvpHttpRequest): Promise<MvpHttpResponse> {
    const traceId = header(request, "x-trace-id") ?? this.#id();
    try {
      const url = new URL(request.url, "https://api.companion-social.invalid");
      const pathname = url.pathname.replace(/\/$/, "") || "/";
      const method = request.method.toUpperCase();
      const session = await authenticate(request, this.#sessions);
      const community = await handleCommunityRequest(request, session, traceId);
      if (community) return community;
      const chat = await handleChatRequest(request, session, traceId, this.#replies);
      if (chat) return chat;

      for (const [routeMethod, path, handler] of ROUTES) {
        const match = routeMethod === method ? path.exec(pathname) : null;
        if (match === null) continue;
        const [status, body] = await handler({
          request,
          query: url.searchParams,
          params: match.slice(1),
          session,
          encounters: this.#encounters,
          id: this.#id,
        });
        return body === undefined ? problem(...NOT_FOUND, traceId) : json(status, body, traceId);
      }
      return problem(404, "ROUTE_NOT_FOUND", "The requested API route was not found.", traceId);
    } catch (error) {
      return mapError(error, traceId);
    }
  }
}
