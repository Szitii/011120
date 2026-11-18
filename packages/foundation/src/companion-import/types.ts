export const IMPORT_STATUSES = [
  "UPLOADED",
  "QUARANTINED",
  "REVIEWABLE",
  "APPROVED",
  "REJECTED",
] as const;

export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export type FindingType =
  | "PROMPT_DIRECTIVE"
  | "POSSIBLE_PROMPT_INJECTION"
  | "CREDENTIAL"
  | "PII"
  | "ACTIVE_CONTENT"
  | "FIELD_CONSTRAINT"
  | "UNKNOWN_FIELD";

export type FindingSeverity = "INFO" | "WARNING" | "BLOCK";

export interface ImportFinding {
  readonly id: string;
  readonly type: FindingType;
  readonly severity: FindingSeverity;
  readonly sourcePath: string;
  readonly action: "EXCLUDED" | "OWNER_REVIEW" | "CANDIDATE_BLOCKED";
  readonly evidenceHash: string;
  readonly safePreview?: string;
}

export type IdentityField =
  | "displayName"
  | "identitySummary"
  | "personaTraits"
  | "speakingStyle"
  | "values"
  | "boundaries"
  | "aspirations"
  | "appearance"
  | "pronouns"
  | "togetherSince";

export interface IdentityCandidate {
  readonly id: string;
  readonly field: IdentityField;
  readonly value: string | readonly string[] | Record<string, unknown>;
  readonly sourcePath: string;
  readonly sourceTrust: "EXTERNAL_UNTRUSTED";
  readonly approvable: boolean;
  readonly blockedByFindingIds: readonly string[];
}

export interface NormalizedIdentityDraft {
  readonly candidates: readonly IdentityCandidate[];
  readonly excludedLegacyMetadataPaths: readonly string[];
}

export interface CompanionImportRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly status: ImportStatus;
  readonly statusHistory: readonly ImportStatus[];
  readonly originalSha256: string;
  readonly byteLength: number;
  readonly parserVersion: string;
  readonly policyVersion: string;
  readonly sourceFormat: "CHARACTER_CARD_JSON_V2" | "LEGACY_CHARACTER_JSON" | "UNKNOWN";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rawPayload: Uint8Array;
  readonly draft?: NormalizedIdentityDraft;
  readonly findings: readonly ImportFinding[];
  readonly rejectionCode?: string;
  readonly approvedIdentityId?: string;
}

export interface Companion {
  readonly id: string;
  readonly ownerId: string;
  readonly status: "ACTIVE";
  readonly originType: "IMPORTED_CARD";
  readonly currentIdentityVersionId: string;
  readonly createdAt: string;
}

export interface CompanionIdentity {
  readonly id: string;
  readonly companionId: string;
  readonly version: number;
  readonly displayName: string;
  readonly identitySummary?: string;
  readonly personaTraits: readonly string[];
  readonly speakingStyle: Record<string, unknown>;
  readonly values: readonly string[];
  readonly boundaries: readonly string[];
  readonly aspirations: readonly string[];
  readonly appearance: Record<string, unknown>;
  readonly pronouns?: string;
  readonly togetherSince?: string;
  readonly sourceManifest: {
    readonly importId: string;
    readonly originalSha256: string;
    readonly parserVersion: string;
    readonly policyVersion: string;
    readonly approvedCandidateIds: readonly string[];
  };
  readonly contentHash: string;
  readonly createdBy: "IMPORT_FIREWALL";
  readonly approvedByOwnerAt: string;
  readonly supersedesIdentityId?: string;
}

export interface IdentityPassport {
  readonly schema: "companion-social.identity-passport";
  readonly schemaVersion: "0.1";
  readonly companionId: string;
  readonly identityVersion: number;
  readonly identityContentHash: string;
  readonly displayName: string;
  readonly identitySummary?: string;
  readonly personaTraits: readonly string[];
  readonly speakingStyle: Record<string, unknown>;
  readonly values: readonly string[];
  readonly boundaries: readonly string[];
  readonly aspirations: readonly string[];
  readonly appearance: Record<string, unknown>;
  readonly pronouns?: string;
  readonly togetherSince?: string;
  readonly provenance: {
    readonly originType: "IMPORTED_CARD";
    readonly originalSha256: string;
    readonly parserVersion: string;
    readonly policyVersion: string;
    readonly approvedAt: string;
  };
  readonly capabilityClaims: {
    readonly executableInstructionsIncluded: false;
    readonly privateMemoryIncluded: false;
    readonly providerCredentialsIncluded: false;
    readonly socialRuntimeAuthority: false;
  };
  readonly passportHash: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly ownerId: string;
  readonly action: "COMPANION_IMPORT_CREATED" | "COMPANION_IMPORT_REJECTED" | "COMPANION_IDENTITY_APPROVED";
  readonly targetType: "COMPANION_IMPORT" | "COMPANION_IDENTITY";
  readonly targetId: string;
  readonly afterHash: string;
  readonly occurredAt: string;
}

export interface ImportReview {
  readonly id: string;
  readonly status: ImportStatus;
  readonly statusHistory: readonly ImportStatus[];
  readonly originalSha256: string;
  readonly byteLength: number;
  readonly parserVersion: string;
  readonly policyVersion: string;
  readonly sourceFormat: CompanionImportRecord["sourceFormat"];
  readonly draft?: NormalizedIdentityDraft;
  readonly findings: readonly ImportFinding[];
  readonly rejectionCode?: string;
  readonly approvedIdentityId?: string;
}

export interface CreateImportCommand {
  readonly ownerId: string;
  readonly idempotencyKey: string;
  readonly payload: Uint8Array | string;
}

export interface ApproveImportCommand {
  readonly ownerId: string;
  readonly importId: string;
  readonly approvedCandidateIds: readonly string[];
  readonly idempotencyKey: string;
  readonly companionId?: string;
}
