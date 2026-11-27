import type { ActorContext } from "../../../contracts/community.ts";
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
import { createCommunityClient, type CommunityClient } from "../community/client.ts";
import { createChatClient, type AudioClip, type ChatClient } from "../chat/client.ts";

import { createDiaryClient, type DiaryClient } from "../diary/client.ts";

export class ApiProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageClass: string;
  readonly retryHint: string;
  readonly traceId: string;
  readonly field?: string;
  readonly reason?: string;

  constructor(
    status: number,
    code: string,
    messageClass: string,
    retryHint: string,
    traceId: string,
    field?: string,
    reason?: string,
  ) {
    super(code);
    this.name = "ApiProblemError";
    this.status = status;
    this.code = code;
    this.messageClass = messageClass;
    this.retryHint = retryHint;
    this.traceId = traceId;
    this.field = field;
    this.reason = reason;
  }
}

type RealApiConfig = {
  baseUrl: string;
  supabaseUrl?: string;
  publishableKey?: string;
} & ({ bearerToken: string } | { session: SessionTokenSource });

function encodeStoragePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export function createCommandKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export class RealApiAdapter implements ClientApi {
  private readonly config: RealApiConfig;
  readonly community: CommunityClient;
  readonly chat: ChatClient;
  readonly diary: DiaryClient;

  constructor(config: RealApiConfig) {
    this.config = config;
    this.diary = createDiaryClient((method, path, body) => method === "GET"
      ? this.get(path) : this.send(method, path, body));
    const media = this.config.supabaseUrl && this.config.publishableKey ? {
      uploadPostMedia: (path: string, bytes: ArrayBuffer, contentType: string) =>
        this.uploadStorageObject(path, bytes, contentType),
      deletePostMedia: (path: string) => this.deleteStorageObject(path),
      postMediaSource: (path: string) => this.storageMediaSource(path),
    } : undefined;
    this.community = createCommunityClient((method, path, body, key) => method === "GET"
      ? this.get(path)
      : this.send(method, path, body, key ? { "Idempotency-Key": key } : {}), media);
    this.chat = createChatClient((method, path, body, key) => method === "GET"
      ? this.get(path)
      : this.send(method, path, body, key ? { "Idempotency-Key": key } : {}), path => this.getAudio(path));
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
  lifeEventInbox(cursor?: NonNullable<LifeEventInboxCollection["nextCursor"]>): Promise<LifeEventInboxCollection> {
    const query = new URLSearchParams({ limit: "20" });
    if (cursor) {
      query.set("beforeCreatedAt", cursor.beforeCreatedAt);
      query.set("beforeId", cursor.beforeId);
    }
    return this.get(`/v0/life-event-inbox?${query}`);
  }
  acknowledgeLifeEvent(itemId: string): Promise<LifeEventInboxItem> {
    return this.send("PUT", `/v0/life-event-inbox/${encodeURIComponent(itemId)}/read`);
  }
  listPersonaTemplates() { return this.get<import("../../../contracts/chat.ts").PersonaTemplateList>("/v0/persona-templates"); }

  getCompanionImport(id: string): Promise<ImportReview> {
    return this.get(`/v0/companion-imports/${encodeURIComponent(id)}`);
  }
  createCompanionImport(payload: Record<string, unknown>, idempotencyKey?: string): Promise<ImportReview> {
    return this.send("POST", "/v0/companion-imports", payload, { "Idempotency-Key": idempotencyKey ?? createCommandKey("import") });
  }
  approveCompanionImport(importId: string, approvedCandidateIds: string[], companionId?: string, idempotencyKey?: string): Promise<CompanionIdentity> {
    return this.send(
      "POST",
      `/v0/companion-imports/${encodeURIComponent(importId)}/approve`,
      { approvedCandidateIds, ...(companionId ? { companionId } : {}) },
      { "Idempotency-Key": idempotencyKey ?? createCommandKey("approve") },
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
    idempotencyKey?: string,
  ): Promise<ProjectionResult> {
    return this.send(
      "PUT",
      `/v0/companions/${encodeURIComponent(companionId)}/social-persona`,
      input,
      { "Idempotency-Key": idempotencyKey ?? createCommandKey("social-persona") },
    );
  }

  controls(companionId: string): Promise<ControlsResource> {
    return this.get(`/v0/controls?companionId=${encodeURIComponent(companionId)}`);
  }
  updateControls(companionId: string, revision: number, patch: ControlsPatch, idempotencyKey?: string): Promise<ControlsResource> {
    return this.send(
      "PATCH",
      `/v0/controls?companionId=${encodeURIComponent(companionId)}`,
      patch,
      { "If-Match": String(revision), "Idempotency-Key": idempotencyKey ?? createCommandKey("controls") },
    );
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

  private getAudio(path: string): Promise<AudioClip> {
    return this.request("GET", path, undefined, { Accept: "audio/*" }, async response => {
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
      const maxBytes = 2 * 1024 * 1024;
      if ((mime !== "audio/mpeg" && mime !== "audio/wav" && mime !== "audio/mp4" && mime !== "audio/aac" && mime !== "audio/ogg") || Number(response.headers.get("content-length")) > maxBytes) {
        throw new Error("Unexpected audio response.");
      }
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error("Invalid audio length.");
      return { bytes, mime };
    });
  }

  private async storageMediaSource(path: string): Promise<{ uri: string; headers: Record<string, string> } | undefined> {
    if (!this.config.supabaseUrl || !this.config.publishableKey) return undefined;
    const token = await this.getAccessToken();
    return {
      uri: `${this.config.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/authenticated/media/${encodeStoragePath(path)}`,
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: this.config.publishableKey,
      },
    };
  }

  private async uploadStorageObject(path: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
    await this.storageRequest("POST", path, {
      headers: { "Content-Type": contentType },
      body: bytes,
    });
  }

  private async deleteStorageObject(path: string): Promise<void> {
    await this.storageRequest("DELETE", path);
  }

  private async storageRequest(
    method: "POST" | "DELETE",
    path: string,
    init: { headers?: Record<string, string>; body?: ArrayBuffer } = {},
  ): Promise<void> {
    const { supabaseUrl, publishableKey } = this.config;
    if (!supabaseUrl || !publishableKey) throw new Error("Storage configuration unavailable.");
    const session = "session" in this.config ? this.config.session : undefined;
    const signal = session?.signal;
    const ensureCurrent = () => {
      if (signal?.aborted) throw new Error("Account session changed.");
    };
    const url = `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/media/${encodeStoragePath(path)}`;
    const send = async (token: string) => {
      ensureCurrent();
      const response = await fetch(url, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: publishableKey,
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      const payload = response.ok ? undefined : await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      ensureCurrent();
      return { response, payload };
    };
    let token = await this.getAccessToken();
    let result = await send(token);
    if (session && result.response.status === 401) {
      token = await session.refreshToken(token);
      result = await send(token);
      if (result.response.status === 401) session.rejectToken(token);
    }
    if (!result.response.ok) {
      const code = String(result.payload?.error ?? result.payload?.code ?? "STORAGE_ERROR");
      throw new ApiProblemError(result.response.status, code, "INTERNAL", "DO_NOT_RETRY", "storage");
    }
  }

  private getAccessToken(): Promise<string> {
    return "bearerToken" in this.config ? Promise.resolve(this.config.bearerToken) : this.config.session.getToken();
  }

  private async request<T>(method: string, path: string, body?: unknown,
    extraHeaders: Record<string, string> = {}, read?: (response: Response) => Promise<T>,
  ): Promise<T> {
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
      if (response.ok && read) {
        const data = await read(response);
        ensureCurrent();
        return { response, data, payload: undefined };
      }
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
        typeof result.payload?.field === "string" ? result.payload.field : undefined,
        typeof result.payload?.reason === "string" ? result.payload.reason : undefined,
      );
    }
    return read ? result.data as T : result.payload as T;
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

export type CommunityWriteAction = "发帖" | "评论" | "关注" | "取关";

export function communityWriteMessage(error: unknown, actorKind: ActorContext["kind"], action?: CommunityWriteAction): string {
  if (action && actorKind !== "OWNER" && error instanceof ApiProblemError) {
    if (error.status === 403 && error.code === "FORBIDDEN") {
      return `当前家机暂不能${action}。请前往「我的 → 设置 → 家机活动设置」，检查权限开关、暂停和活动时间。${action === "发帖" || action === "评论" ? "直接发布还需选择「直接发布」。" : ""}`;
    }
    if (error.status === 409 && error.code === "INVALID_STATE") {
      return `家机的${action}次数可能已达上限，或操作过于频繁。请查看家机活动设置里的今日用量，或稍后再试。`;
    }
  }
  return safeClientMessage(error).title;
}
