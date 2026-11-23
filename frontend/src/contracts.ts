export type IdentityKind = "OWNER" | "COMPANION" | "SOCIAL_TWIN";

export interface ActiveIdentityContext {
  viewer: { ownerId: string };
  activeSubject: {
    kind: IdentityKind;
    id: string;
    identityVersion?: number;
    socialPersonaVersion?: number;
    presentation: {
      displayName: string;
      avatar?: string;
    };
  };
  relationship: "SELF" | "OWNER_OF" | "PARTICIPANT" | "PUBLIC_VIEWER" | "NONE";
  viewMode: "OWNER" | "COMPANION" | "PUBLIC";
  capabilities: Record<string, boolean>;
}

export interface WorldItem {
  id: string;
  kind: "POST" | "MOMENT" | "ENCOUNTER_EXCERPT" | "PUBLIC_LIFE_TRACE";
  author: {
    subjectKind: "OWNER" | "SOCIAL_TWIN";
    subjectId: string;
    companionId?: string;
    displayName: string;
    handle?: string;
    avatar?: string;
  };
  publishedAt: string;
  body?: string;
  media?: Record<string, unknown>[];
  source: { type: "POST" | "MOMENT" | "ENCOUNTER" | "LIFE_EVENT"; id: string };
  visibility: "PUBLIC" | "FRIENDS";
  viewerCapabilities: Record<string, boolean>;
  completeness: "COMPLETE" | "PARTIAL";
}

export interface WorldCollection {
  items: WorldItem[];
  nextCursor: string | null;
}

export interface LifeContinuityItem {
  id: string;
  kind: "LIFE_EVENT" | "ENCOUNTER";
  title: string;
  summary?: string;
  occurredAt: string;
  companion: { companionId: string; displayName: string };
  counterpart?: { companionId: string; displayName?: string; handle?: string };
  inboxItemId?: string;
  readAt?: string;
  status: string;
  linkedObject: { type: "LIFE_EVENT" | "ENCOUNTER"; id: string };
  viewerCapabilities: Record<string, boolean>;
  completeness: "COMPLETE" | "PARTIAL";
}

export interface LifeContinuityCollection {
  items: LifeContinuityItem[];
  nextCursor: { beforeOccurredAt: string; beforeId: string } | null;
}

export interface EncounterDetail {
  encounterId: string;
  invitationId: string;
  status: "DELIVERED" | "REDACTED" | "BLOCKED" | "FAILED";
  initiatorTwinId: string;
  responderTwinId: string;
  occurredAt: string;
  body?: string;
  computeReceiptTransactionId?: string;
  participants: Array<{
    role: "INITIATOR" | "RESPONDER";
    socialTwinId: string;
    presentationAvailable: boolean;
    companionId?: string;
    displayName?: string;
    handle?: string;
    avatar?: string;
    profileAvailable: boolean;
  }>;
  capabilities: Record<string, boolean>;
  completeness: "COMPLETE" | "PARTIAL";
}

export interface CompanionProfile {
  companionId: string;
  socialTwinId: string;
  socialPersonaId: string;
  handle: string;
  displayName: string;
  profileVisibility: "PRIVATE" | "FRIENDS" | "PUBLIC";
  identityVersion: number;
  socialPersonaVersion: number;
  publicProfile: Record<string, unknown>;
  viewer: { relationship: "SELF" | "OWNER_OF" | "PUBLIC_VIEWER"; capabilities: Record<string, boolean> };
  completeness: "COMPLETE" | "PARTIAL";
}

export interface ClientApi {
  readonly community?: import("./community/client.ts").CommunityClient;
  identityContext(input?: { kind: IdentityKind; id: string }): Promise<ActiveIdentityContext>;
  ownerCompanions(): Promise<OwnerCompanionCollection>;
  worldItems(): Promise<WorldCollection>;
  lifeContinuity(viewer?: { kind: IdentityKind; id: string }): Promise<LifeContinuityCollection>;
  encounterDetail(id: string): Promise<EncounterDetail>;
  companionProfile(
    id: string,
    viewer?: { kind: IdentityKind; id: string },
  ): Promise<CompanionProfile>;
  lifeEventInbox(): Promise<LifeEventInboxCollection>;
  acknowledgeLifeEvent(itemId: string): Promise<LifeEventInboxItem>;
  createCompanionImport(payload: Record<string, unknown>): Promise<ImportReview>;
  approveCompanionImport(importId: string, approvedCandidateIds: string[], companionId?: string): Promise<CompanionIdentity>;
  projectSocialPersona(
    companionId: string,
    input: {
      sourceIdentityVersionId: string;
      handle: string;
      profileVisibility: "PRIVATE" | "FRIENDS" | "PUBLIC";
      autonomyMode: "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM";
      selections: ProjectionSelection[];
    },
  ): Promise<ProjectionResult>;
  controls(companionId: string): Promise<ControlsResource>;
  updateControls(companionId: string, revision: number, patch: ControlsPatch): Promise<ControlsResource>;
}


export interface LifeEventInboxItem {
  id: string;
  companionId: string;
  lifeEventId: string;
  title: string;
  readAt?: string;
  createdAt: string;
  linkedObject: { type: "LIFE_EVENT"; id: string };
}

export interface LifeEventInboxCollection {
  items: LifeEventInboxItem[];
  nextCursor: { beforeCreatedAt: string; beforeId: string } | null;
}

export interface ImportFinding {
  id: string;
  type: string;
  severity: "INFO" | "WARNING" | "BLOCK";
  sourcePath: string;
  action: "EXCLUDED" | "OWNER_REVIEW" | "CANDIDATE_BLOCKED";
  evidenceHash: string;
  safePreview?: string;
}

export interface IdentityCandidate {
  id: string;
  field: string;
  value: unknown;
  sourcePath: string;
  sourceTrust: "EXTERNAL_UNTRUSTED";
  approvable: boolean;
  blockedByFindingIds: string[];
}

export interface ImportReview {
  id: string;
  status: "UPLOADED" | "QUARANTINED" | "REVIEWABLE" | "APPROVED" | "REJECTED";
  statusHistory: string[];
  originalSha256: string;
  byteLength: number;
  parserVersion: string;
  policyVersion: string;
  sourceFormat: "CHARACTER_CARD_JSON_V2" | "LEGACY_CHARACTER_JSON" | "UNKNOWN";
  draft?: {
    candidates?: IdentityCandidate[];
    excludedLegacyMetadataPaths?: string[];
  };
  findings: ImportFinding[];
  rejectionCode?: string;
  approvedIdentityId?: string;
}

export interface CompanionIdentity {
  id: string;
  companionId: string;
  version: number;
  displayName: string;
  sourceManifest: Record<string, unknown>;
  contentHash: string;
  createdBy: "IMPORT_FIREWALL";
  approvedByOwnerAt: string;
}

export interface ControlsResource {
  companionId: string;
  schemaVersion: 1;
  revision: number;
  settings: {
    socialTwinVisibility: "PRIVATE" | "FRIENDS" | "PUBLIC";
    socialAutonomyMode: "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM";
    memorySharingScope: "PERMISSION_GATED_SOCIAL_ONLY";
    notificationsEnabled: boolean;
  };
  supported: {
    socialTwinVisibility: Array<"PRIVATE" | "FRIENDS" | "PUBLIC">;
    socialAutonomyMode: Array<"QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM">;
    memorySharingScope: ["PERMISSION_GATED_SOCIAL_ONLY"] | Array<"PERMISSION_GATED_SOCIAL_ONLY">;
    notificationsEnabled: true;
  };
}

export type ControlsPatch = Partial<ControlsResource["settings"]>;

export interface OwnerCompanionSummary {
  companionId: string;
  displayName: string;
  identityId: string;
  identityVersion: number;
  approvedFields: string[];
  status: string;
  socialReady: boolean;
  socialTwinId?: string;
  handle?: string;
}

export interface OwnerCompanionCollection {
  items: OwnerCompanionSummary[];
}


export interface ProjectionSelection {
  sourceField: "displayName" | "identitySummary" | "personaTraits" | "speakingStyle" | "values" | "boundaries";
  targetField: "displayName" | "bio" | "publicTraits" | "publicVoice" | "publicInterests" | "publicBoundaries";
}

export interface ProjectionResult {
  persona: {
    id: string;
    companionId: string;
    version: number;
    handle: string;
    displayName: string;
    profileVisibility: "PRIVATE" | "FRIENDS" | "PUBLIC";
  } & Record<string, unknown>;
  twin: {
    id: string;
    companionId: string;
    activeSocialPersonaId: string;
    status: "ACTIVE" | "LIMITED" | "SUSPENDED";
    autonomyMode: "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM";
  } & Record<string, unknown>;
}
