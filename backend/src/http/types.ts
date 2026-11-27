import type {
  CompanionIdentity,
  ImportFinding,
  ImportReview,
  ImportSourceFormat,
  NormalizedIdentityDraft,
} from "../companion-import/types.ts";

export interface MvpHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface MvpHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}


export interface ActiveIdentityContextView {
  readonly viewer: { readonly ownerId: string };
  readonly activeSubject: {
    readonly kind: "OWNER" | "COMPANION" | "SOCIAL_TWIN";
    readonly id: string;
    readonly identityVersion?: number;
    readonly socialPersonaVersion?: number;
    readonly presentation: {
      readonly displayName: string;
      readonly avatar?: string;
    };
  };
  readonly relationship: "SELF" | "OWNER_OF" | "PARTICIPANT" | "PUBLIC_VIEWER" | "NONE";
  readonly viewMode: "OWNER" | "COMPANION" | "PUBLIC";
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface WorldItemView {
  readonly id: string;
  readonly kind: "POST" | "MOMENT" | "ENCOUNTER_EXCERPT" | "PUBLIC_LIFE_TRACE";
  readonly author: {
    readonly subjectKind: "OWNER" | "SOCIAL_TWIN";
    readonly subjectId: string;
    readonly companionId?: string;
    readonly displayName: string;
    readonly handle?: string;
    readonly avatar?: string;
  };
  readonly publishedAt: string;
  readonly body?: string;
  readonly media?: readonly Readonly<Record<string, unknown>>[];
  readonly source: {
    readonly type: "POST" | "MOMENT" | "ENCOUNTER" | "LIFE_EVENT";
    readonly id: string;
  };
  readonly visibility: "PUBLIC" | "FRIENDS";
  readonly viewerCapabilities: Readonly<Record<string, boolean>>;
  readonly completeness: "COMPLETE" | "PARTIAL";
}

export interface WorldCollectionView {
  readonly items: readonly WorldItemView[];
  readonly nextCursor: string | null;
}

export interface LifeContinuityItemView {
  readonly id: string;
  readonly kind: "LIFE_EVENT" | "ENCOUNTER";
  readonly title: string;
  readonly summary?: string;
  readonly occurredAt: string;
  readonly companion: {
    readonly companionId: string;
    readonly displayName: string;
  };
  readonly counterpart?: {
    readonly companionId: string;
    readonly displayName?: string;
    readonly handle?: string;
  };
  readonly inboxItemId?: string;
  readonly readAt?: string;
  readonly status: string;
  readonly linkedObject: {
    readonly type: "LIFE_EVENT" | "ENCOUNTER";
    readonly id: string;
  };
  readonly viewerCapabilities: Readonly<Record<string, boolean>>;
  readonly completeness: "COMPLETE" | "PARTIAL";
}

export interface LifeContinuityCollectionView {
  readonly items: readonly LifeContinuityItemView[];
  readonly nextCursor: { readonly beforeOccurredAt: string; readonly beforeId: string } | null;
}

export interface CompanionProfileView {
  readonly companionId: string;
  readonly socialTwinId: string;
  readonly socialPersonaId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly profileVisibility: "PRIVATE" | "FRIENDS" | "PUBLIC";
  readonly identityVersion: number;
  readonly socialPersonaVersion: number;
  readonly publicProfile: Readonly<Record<string, unknown>>;
  readonly viewer: {
    readonly relationship: "SELF" | "OWNER_OF" | "PUBLIC_VIEWER";
    readonly capabilities: Readonly<Record<string, boolean>>;
  };
  readonly completeness: "COMPLETE" | "PARTIAL";
}


export interface LifeEventInboxItemView {
  readonly id: string;
  /** LIFE_EVENT: a life event. AGENT_DRAFT: a Companion's draft waiting for review. */
  readonly kind: "LIFE_EVENT" | "AGENT_DRAFT";
  /** LIFE_EVENT only. */
  readonly lifeEventId?: string;
  readonly companionId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly readAt?: string;
  readonly linkedObject: { readonly type: "LIFE_EVENT" | "AGENT_DRAFT"; readonly id: string };
}

export interface LifeEventInboxCollectionView {
  readonly items: readonly LifeEventInboxItemView[];
  readonly nextCursor: { readonly beforeCreatedAt: string; readonly beforeId: string } | null;
}


export type SocialTwinVisibilityControl = "PRIVATE" | "FRIENDS" | "PUBLIC";
export type SocialAutonomyModeControl = "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM";
export type MemorySharingScopeControl = "PERMISSION_GATED_SOCIAL_ONLY";

export interface ControlsSettingsView {
  readonly socialTwinVisibility: SocialTwinVisibilityControl;
  readonly socialAutonomyMode: SocialAutonomyModeControl;
  readonly memorySharingScope: MemorySharingScopeControl;
  readonly notificationsEnabled: boolean;
}

export interface ControlsPatchInput {
  readonly socialTwinVisibility?: SocialTwinVisibilityControl;
  readonly socialAutonomyMode?: SocialAutonomyModeControl;
  readonly memorySharingScope?: MemorySharingScopeControl;
  readonly notificationsEnabled?: boolean;
}

export interface ProjectionSelectionInput {
  readonly sourceField: "displayName" | "identitySummary" | "personaTraits" | "speakingStyle" | "values" | "boundaries";
  readonly targetField: "displayName" | "bio" | "publicTraits" | "publicVoice" | "publicInterests" | "publicBoundaries";
}

export interface ProjectionResultView {
  readonly persona: Readonly<Record<string, unknown>>;
  readonly twin: Readonly<Record<string, unknown>>;
}

export interface OwnerCompanionSummaryView {
  readonly companionId: string;
  readonly displayName: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly approvedFields: readonly string[];
  readonly status: string;
  readonly socialReady: boolean;
  readonly socialTwinId?: string;
  readonly handle?: string;
  /** "preset:<id>"; left out when none is chosen. */
  readonly avatar?: string;
}

export interface ControlsResourceView {
  readonly companionId: string;
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly settings: ControlsSettingsView;
  readonly supported: {
    readonly socialTwinVisibility: readonly SocialTwinVisibilityControl[];
    readonly socialAutonomyMode: readonly SocialAutonomyModeControl[];
    readonly memorySharingScope: readonly MemorySharingScopeControl[];
    readonly notificationsEnabled: true;
  };
}

export interface OwnerApiPort {
  getIdentityContext(input?: { readonly activeSubjectKind?: "OWNER" | "COMPANION" | "SOCIAL_TWIN"; readonly activeSubjectId?: string }): Promise<ActiveIdentityContextView>;
  listOwnerCompanions(): Promise<readonly OwnerCompanionSummaryView[]>;
  listWorldItems(limit: number, beforeCreatedAt?: string): Promise<WorldCollectionView>;
  listLifeContinuity(
    limit: number,
    viewer?: { readonly activeSubjectKind: "OWNER" | "COMPANION" | "SOCIAL_TWIN"; readonly activeSubjectId?: string },
    before?: { readonly occurredAt: string; readonly id: string },
  ): Promise<LifeContinuityCollectionView>;
  getCompanionProfile(
    companionId: string,
    viewer?: { readonly activeSubjectKind: "OWNER" | "COMPANION" | "SOCIAL_TWIN"; readonly activeSubjectId?: string },
  ): Promise<CompanionProfileView | undefined>;
  listLifeEventInbox(limit: number, before?: { readonly createdAt: string; readonly id: string }): Promise<LifeEventInboxCollectionView>;
  acknowledgeLifeEvent(itemId: string): Promise<LifeEventInboxItemView | undefined>;
  getControls(companionId: string): Promise<ControlsResourceView | undefined>;
  updateControls(input: {
    readonly companionId: string;
    readonly ifMatch: number;
    readonly patch: ControlsPatchInput;
    readonly idempotencyKeyHash: string;
    readonly requestHash: string;
  }): Promise<ControlsResourceView | undefined>;
  createCompanionImport(input: {
    readonly rawPayload: string;
    readonly originalSha256: string;
    readonly byteLength: number;
    readonly parserVersion: string;
    readonly policyVersion: string;
    readonly sourceFormat: ImportSourceFormat;
    readonly draft: NormalizedIdentityDraft;
    readonly findings: readonly ImportFinding[];
    readonly idempotencyKeyHash: string;
    readonly requestHash: string;
  }): Promise<ImportReview>;
  getCompanionImportReview(importId: string): Promise<ImportReview | undefined>;
  projectAndActivateSocialTwin(input: {
    readonly companionId: string;
    readonly sourceIdentityVersionId: string;
    readonly handle: string;
    readonly profileVisibility: "PRIVATE" | "FRIENDS" | "PUBLIC";
    readonly autonomyMode: "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM";
    readonly selections: readonly ProjectionSelectionInput[];
    readonly idempotencyKeyHash: string;
    readonly requestHash: string;
  }): Promise<ProjectionResultView>;
  approveCompanionImport(input: {
    readonly importId: string;
    readonly approvedCandidateIds: readonly string[];
    readonly companionId?: string;
    readonly idempotencyKeyHash: string;
    readonly requestHash: string;
  }): Promise<CompanionIdentity>;
}

export interface AuthenticatedOwnerSession {
  readonly ownerId: string;
  readonly owner: OwnerApiPort;
  readonly community?: import("../community/port.ts").CommunityPort;
  readonly chat?: import("../chat/port.ts").ChatPort;
  /** Set when the caller is the Owner's agent with an agent key: it may only check in (agent/heartbeat.ts). */
  readonly agent?: { readonly keyId: string; readonly companionId: string; readonly scopes: readonly string[] };
}

export interface OwnerSessionResolver {
  resolve(bearerToken: string): Promise<AuthenticatedOwnerSession>;
}

export class ApiAuthenticationError extends Error {
  readonly code: "AUTHENTICATION_REQUIRED" | "INVALID_TOKEN";

  constructor(code: "AUTHENTICATION_REQUIRED" | "INVALID_TOKEN") {
    super(code);
    this.name = "ApiAuthenticationError";
    this.code = code;
  }
}

export class OwnerSessionError extends Error {
  readonly code: "FORBIDDEN" | "SERVICE_UNAVAILABLE";

  constructor(code: "FORBIDDEN" | "SERVICE_UNAVAILABLE") {
    super(code);
    this.code = code;
    this.name = "OwnerSessionError";
  }
}

export interface ApiProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly messageClass: "AUTH" | "PERMISSION" | "VALIDATION" | "CONFLICT" | "RATE_LIMIT" | "AVAILABILITY" | "CAPABILITY" | "INTERNAL";
  readonly retryHint: "DO_NOT_RETRY" | "RETRY_SAME_REQUEST" | "RETRY_AFTER" | "REFRESH_AND_RETRY";
  readonly traceId: string;
}
