export type SocialVisibility = "PRIVATE" | "FRIENDS" | "PUBLIC";

export type PrivateProjectionField =
  | "displayName"
  | "identitySummary"
  | "personaTraits"
  | "speakingStyle"
  | "values"
  | "boundaries";

export type PublicProjectionField =
  | "displayName"
  | "bio"
  | "publicTraits"
  | "publicVoice"
  | "publicInterests"
  | "publicBoundaries";

export interface ProjectionSelection {
  readonly sourceField: PrivateProjectionField;
  readonly targetField: PublicProjectionField;
}

export interface ProjectionManifestEntry extends ProjectionSelection {
  readonly sourceValueHash: string;
}

export interface SocialPersona {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly version: number;
  readonly handle: string;
  readonly displayName: string;
  readonly bio?: string;
  readonly publicTraits: readonly string[];
  readonly publicVoice: Record<string, unknown>;
  readonly publicInterests: readonly string[];
  readonly publicBoundaries: readonly string[];
  readonly profileVisibility: SocialVisibility;
  readonly approvedByOwnerAt: string;
  readonly sourceIdentityVersionId: string;
  readonly sourceIdentityVersion: number;
  readonly sourceIdentityContentHash: string;
  readonly projectionManifest: readonly ProjectionManifestEntry[];
  readonly supersedesSocialPersonaId?: string;
  readonly contentHash: string;
}

export interface SocialTwin {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly activeSocialPersonaId: string;
  readonly status: "ACTIVE" | "LIMITED" | "SUSPENDED";
  readonly autonomyMode: "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM";
  readonly socialMemoryNamespaceId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SocialRuntimeView {
  readonly principalType: "SOCIAL_TWIN";
  readonly socialTwinId: string;
  readonly companionId: string;
  readonly socialPersonaId: string;
  readonly socialPersonaVersion: number;
  readonly handle: string;
  readonly displayName: string;
  readonly bio?: string;
  readonly publicTraits: readonly string[];
  readonly publicVoice: Record<string, unknown>;
  readonly publicInterests: readonly string[];
  readonly publicBoundaries: readonly string[];
  readonly socialMemoryNamespaceId: string;
}

export interface ProjectSocialTwinCommand {
  readonly ownerId: string;
  readonly companionId: string;
  readonly sourceIdentityVersionId: string;
  readonly handle: string;
  readonly profileVisibility: SocialVisibility;
  readonly autonomyMode: SocialTwin["autonomyMode"];
  readonly selections: readonly ProjectionSelection[];
  readonly idempotencyKey: string;
}

export interface ProjectionResult {
  readonly persona: SocialPersona;
  readonly twin: SocialTwin;
}

export interface ProjectionAuditEvent {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly action: "SOCIAL_PERSONA_PROJECTED" | "SOCIAL_PERSONA_ACTIVATED";
  readonly targetId: string;
  readonly afterHash: string;
  readonly occurredAt: string;
}
