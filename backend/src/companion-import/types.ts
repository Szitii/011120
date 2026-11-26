export type ImportStatus = "UPLOADED" | "QUARANTINED" | "REVIEWABLE" | "APPROVED" | "REJECTED";

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
  | "togetherSince"
  | "dialogueExamples";

/**
 * "memory": one thing the Companion remembers; approved ones go to its memories, not into the identity.
 * "worldEntry": one world book entry, {keys, body}; approved ones go to its world book.
 */
export type CandidateField = IdentityField | "memory" | "worldEntry";

export interface IdentityCandidate {
  readonly id: string;
  readonly field: CandidateField;
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

export type ImportSourceFormat = "CHARACTER_CARD_JSON_V2" | "LEGACY_CHARACTER_JSON" | "UNKNOWN";

export interface ImportReview {
  readonly id: string;
  readonly status: ImportStatus;
  readonly statusHistory: readonly ImportStatus[];
  readonly originalSha256: string;
  readonly byteLength: number;
  readonly parserVersion: string;
  readonly policyVersion: string;
  readonly sourceFormat: ImportSourceFormat;
  readonly draft?: NormalizedIdentityDraft;
  readonly findings: readonly ImportFinding[];
  readonly rejectionCode?: string;
  readonly approvedIdentityId?: string;
}
