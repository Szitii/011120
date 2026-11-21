import type { SessionTokenSource } from "../auth/account-session.ts";
import type {
  ActiveIdentityContext,
  ClientApi,
  CompanionIdentity,
  CompanionProfile,
  ControlsPatch,
  ControlsResource,
  EncounterDetail,
  IdentityKind,
  ImportReview,
  LifeContinuityCollection,
  LifeEventInboxCollection,
  LifeEventInboxItem,
  OwnerCompanionCollection,
  ProjectionResult,
  ProjectionSelection,
  WorldCollection,
} from "../contracts.ts";
import { createCommunityClient } from "../community/client.ts";

export class ApiProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageClass: string;
  readonly retryHint: string;
  readonly traceId: string;

  constructor(status: number, code: string, messageClass: string, retryHint: string, traceId: string) {
    super(code);
    this.name = "ApiProblemError";
    this.status = status;
    this.code = code;
    this.messageClass = messageClass;
    this.retryHint = retryHint;
    this.traceId = traceId;
  }
}

type RealApiConfig = { baseUrl: string } & ({ bearerToken: string } | { session: SessionTokenSource });

export class RealApiAdapter implements ClientApi {
  private readonly config: RealApiConfig;
  readonly community: import("../../../../packages/community-contracts/types.ts").CommunityClient;

  constructor(config: RealApiConfig) {
    this.config = config;
    this.community = createCommunityClient((method, path, body, key) => method === "GET"
      ? this.get(path)
      : this.send(method, path, body, key ? { "Idempotency-Key": key } : {}));
  }

  async identityContext(input?: { kind: IdentityKind; id: string }): Promise<ActiveIdentityContext> {
    const query = input ? `?activeSubjectKind=${encodeURIComponent(input.kind)}&activeSubjectId=${encodeURIComponent(input.id)}` : "";
    return this.get<ActiveIdentityContext>(`/v0/identity-context${query}`);
  }

  ownerCompanions(): Promise<OwnerCompanionCollection> { return this.get("/v0/companions"); }
  worldItems(): Promise<WorldCollection> { return this.get("/v0/world-items?limit=20"); }
  lifeContinuity(viewer?: { kind: IdentityKind; id: string }): Promise<LifeContinuityCollection> {
    const subject = viewer
      ? `&activeSubjectKind=${encodeURIComponent(viewer.kind)}&activeSubjectId=${encodeURIComponent(viewer.id)}`
      : "&activeSubjectKind=OWNER";
    return this.get(`/v0/life-continuity?limit=30${subject}`);
  }
  encounterDetail(id: string): Promise<EncounterDetail> { return this.get(`/v0/encounters/${encodeURIComponent(id)}`); }
  companionProfile(id: string, viewer?: { kind: IdentityKind; id: string }): Promise<CompanionProfile> {
    const query = viewer
      ? `?activeSubjectKind=${encodeURIComponent(viewer.kind)}&activeSubjectId=${encodeURIComponent(viewer.id)}`
      : "?activeSubjectKind=OWNER";
    return this.get(`/v0/companions/${encodeURIComponent(id)}/profile${query}`);
  }
  lifeEventInbox(): Promise<LifeEventInboxCollection> { return this.get("/v0/life-event-inbox?limit=20"); }
  acknowledgeLifeEvent(itemId: string): Promise<LifeEventInboxItem> {
    return this.send("PUT", `/v0/life-event-inbox/${encodeURIComponent(itemId)}/read`);
  }
  createCompanionImport(payload: Record<string, unknown>): Promise<ImportReview> {
    return this.send("POST", "/v0/companion-imports", payload, { "Idempotency-Key": this.idempotencyKey("import") });
  }
  approveCompanionImport(importId: string, approvedCandidateIds: string[], companionId?: string): Promise<CompanionIdentity> {
    return this.send(
      "POST",
      `/v0/companion-imports/${encodeURIComponent(importId)}/approve`,
      { approvedCandidateIds, ...(companionId ? { companionId } : {}) },
      { "Idempotency-Key": this.idempotencyKey("approve") },
    );
  }
  projectSocialPersona(
    companionId: string,
    input: {
      sourceIdentityVersionId: string;
      handle: string;
      profileVisibility: "PRIVATE" | "FRIENDS" | "PUBLIC";
      autonomyMode: "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM";
      selections: ProjectionSelection[];
    },
  ): Promise<ProjectionResult> {
    return this.send(
      "PUT",
      `/v0/companions/${encodeURIComponent(companionId)}/social-persona`,
      input,
      { "Idempotency-Key": this.idempotencyKey("social-persona") },
    );
  }

  controls(companionId: string): Promise<ControlsResource> {
    return this.get(`/v0/controls?companionId=${encodeURIComponent(companionId)}`);
  }
  updateControls(companionId: string, revision: number, patch: ControlsPatch): Promise<ControlsResource> {
    return this.send(
      "PATCH",
      `/v0/controls?companionId=${encodeURIComponent(companionId)}`,
      patch,
      { "If-Match": String(revision), "Idempotency-Key": this.idempotencyKey("controls") },
    );
  }

  private idempotencyKey(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }

  private get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  private send<T>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    return this.request(method, path, body, extraHeaders);
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const session = "session" in this.config ? this.config.session : undefined;
    const signal = session?.signal;
    const ensureCurrent = () => {
      if (signal?.aborted) throw new Error("Account session changed.");
    };

    const send = async (token: string) => {
      ensureCurrent();
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      ensureCurrent();
      return { response, payload };
    };

    let token = "bearerToken" in this.config ? this.config.bearerToken : await this.config.session.getToken();
    let result = await send(token);
    const rejected = () => result.response.status === 401 && result.payload?.code === "INVALID_TOKEN";
    if (session && rejected()) {
      // Authentication is checked before command dispatch. Retrying keeps the original idempotency key.
      token = await session.refreshToken(token);
      result = await send(token);
      if (rejected()) session.rejectToken(token);
    }
    if (!result.response.ok) {
      throw new ApiProblemError(
        result.response.status,
        String(result.payload?.code ?? "HTTP_ERROR"),
        String(result.payload?.messageClass ?? "INTERNAL"),
        String(result.payload?.retryHint ?? "DO_NOT_RETRY"),
        String(result.payload?.traceId ?? "unknown"),
      );
    }
    return result.payload as T;
  }
}

export function safeClientMessage(error: unknown): { title: string; retry: boolean } {
  if (!(error instanceof ApiProblemError)) return { title: "没连上。", retry: true };
  switch (error.status) {
    case 401: return { title: "会话过期了。", retry: false };
    case 403: return { title: "这里不能进。", retry: false };
    case 404: return { title: "这条已经不在这儿。", retry: false };
    case 409: return { title: "东西变了。", retry: true };
    case 501: return { title: "这个还没开。", retry: false };
    case 503: return { title: "现在没连上。", retry: true };
    default: return { title: "没连上。", retry: error.retryHint !== "DO_NOT_RETRY" };
  }
}
