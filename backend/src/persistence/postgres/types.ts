import type { BillingParty, ReasonCode } from "../../compute/types.ts";

export interface SqlResult<Row extends Record<string, unknown>> { readonly rows: readonly Row[]; }
export interface SqlExecutor {
  query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<SqlResult<Row>>;
}

export type PersistenceErrorCode =
  "NOT_FOUND" | "INVALID_INPUT" | "CONFLICT" | "FORBIDDEN" | "INVALID_STATE" | "DATABASE_UNAVAILABLE" | "DATABASE_ERROR";

export class PostgresPersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly sqlState?: string;

  constructor(code: PersistenceErrorCode, message: string, sqlState?: string) {
    super(message);
    this.name = "PostgresPersistenceError";
    this.code = code;
    if (sqlState !== undefined) this.sqlState = sqlState;
  }
}

export interface ReserveComputeInput {
  readonly ownerId: string; readonly companionId: string; readonly socialTwinId?: string;
  readonly reasonCode: ReasonCode; readonly triggerEventType: string; readonly triggerEventId: string;
  readonly providerId: string; readonly credentialId?: string; readonly canonicalModel: string; readonly providerModel: string;
  readonly billingParty: BillingParty; readonly currency: string; readonly pricingVersion: string;
  readonly estimatedInputTokens: number; readonly maxOutputTokens: number; readonly reservedCostMinor: number;
  readonly promptTemplateVersion: string; readonly identityVersion: number; readonly socialPersonaVersion?: number;
  readonly memoryPolicyVersion: string; readonly safetyPolicyVersion: string; readonly routerVersion: string;
  readonly traceId: string; readonly attemptNo: number; readonly retryParentTransactionId?: string;
  readonly idempotencyKeyHash: string; readonly requestHash: string;
}

export interface ReserveComputeResult {
  readonly transactionId: string;
  readonly budgetId: string;
  readonly decision: string;
  readonly outcomeCode?: string;
  readonly replayed: boolean;
}

export interface ReservePublicationInput {
  readonly ownerId: string;
  readonly companionId: string;
  readonly relatedEventId: string;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
}

export interface ReservePublicationResult {
  readonly reservationId: string;
  readonly budgetId: string;
  readonly decision: string;
  readonly outcomeCode?: string;
  readonly replayed: boolean;
}

export interface ClaimEncounterInput {
  readonly actorOwnerId: string;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
  readonly encounterId: string;
  readonly invitationId: string;
  readonly generationTransactionId: string;
  readonly publicationReservationId: string;
}

export interface ClaimEncounterResult {
  readonly executionClaimId: string;
  readonly encounterId: string;
  readonly invitationId: string;
  readonly claimedAt: string;
  readonly replayed: boolean;
}

export interface LedgerMutationResult {
  readonly ledgerEntryId: string;
  readonly ledgerSequence: number;
  readonly decision: string;
  readonly replayed: boolean;
}

export interface RecordSafetyEventInput {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly socialTwinId: string;
  readonly direction: "INPUT" | "OUTPUT";
  readonly decision: "ALLOW" | "LIMIT" | "REDACT" | "BLOCK";
  readonly threatTypes: readonly string[];
  readonly contentHash: string;
  readonly sanitizedContentHash?: string;
  readonly redactionCount: number;
  readonly policyVersion: string;
  readonly encounterId: string;
}

export interface SettleComputeInput {
  readonly ownerId: string;
  readonly transactionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly actualCostMinor: number;
  readonly status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  readonly outcomeCode?: string;
  readonly providerRequestIdHash?: string;
}

export interface PersistNonDeliveryInput {
  readonly actorOwnerId: string;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
  readonly encounterId: string;
  readonly invitationId: string;
  readonly resultStatus: "BLOCKED" | "FAILED";
  readonly outcomeCode: string;
  readonly generationTransactionId?: string;
  readonly publicationReservationId?: string;
  readonly safetyEventId?: string;
  readonly occurredAt: string;
}

export interface PersistNonDeliveryResult {
  readonly encounterId: string;
  readonly resultStatus: "BLOCKED" | "FAILED";
  readonly outcomeCode: string;
  readonly invitationConsumed: boolean;
  readonly publicationReleased: boolean;
  readonly replayed: boolean;
}

export interface EncounterTerminalResult {
  readonly encounterId: string;
  readonly resultStatus: "BLOCKED" | "FAILED" | "DELIVERED" | "REDACTED";
  readonly outcomeCode?: string;
}

export interface PersistDeliveryInput {
  readonly actorOwnerId: string;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
  readonly encounterId: string;
  readonly invitationId: string;
  readonly publicationReservationId: string;
  readonly body: string;
  readonly bodyHash: string;
  readonly artifactStatus: "DELIVERED" | "REDACTED";
  readonly generationTransactionId: string;
  readonly outputSafetyEventId: string;
  readonly occurredAt: string;
}

export interface PersistDeliveryResult {
  readonly encounterId: string;
  readonly artifactId: string;
  readonly initiatorLifeEventId: string;
  readonly responderLifeEventId: string;
  readonly resultStatus: "DELIVERED" | "REDACTED";
  readonly replayed: boolean;
}

export interface EncounterPreparation {
  readonly initiatorOwnerId: string;
  readonly initiatorTwinId: string;
  readonly responderOwnerId: string;
  readonly responderCompanionId: string;
  readonly responderTwinId: string;
  readonly responderSocialPersonaVersion: number;
  readonly responderIdentityVersion: number;
}

export interface AssembleEncounterContextInput {
  readonly actorOwnerId: string;
  readonly executionClaimId: string;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
  readonly providerRequestHash: string;
  readonly maxMemories: number;
}

export interface AssembledEncounterContext {
  readonly snapshotId: string;
  readonly encounterId: string;
  readonly generationTransactionId: string;
  readonly initiatorTwinId: string;
  readonly responderOwnerId: string;
  readonly responderCompanionId: string;
  readonly responderTwinId: string;
  readonly responderSocialPersonaVersion: number;
  readonly responderIdentityVersion: number;
  readonly responderPersona: {
    readonly socialTwinId: string;
    readonly socialPersonaId: string;
    readonly socialPersonaVersion: number;
    readonly handle: string;
    readonly displayName: string;
    readonly publicTraits: readonly string[];
    readonly publicVoice: Readonly<Record<string,string>>;
    readonly publicInterests: readonly string[];
    readonly publicBoundaries: readonly string[];
  };
  readonly authorizedMemories: readonly {
    readonly id: string;
    readonly representation: string;
    readonly disclosure: "PRESENCE_ONLY" | "SUMMARY";
    readonly sourceTrust: "OWNER_ASSERTED" | "PLATFORM_EVENT" | "MODEL_DERIVED" | "EXTERNAL_UNTRUSTED";
  }[];
  readonly manifest: Readonly<Record<string,unknown>>;
  readonly manifestHash: string;
  readonly replayed: boolean;
}

export interface ReconcileStartedInput {
  readonly actorOwnerId: string;
  readonly executionClaimId: string;
  readonly reasonCode: string;
  readonly evidenceSource: "PROVIDER_RECORD_UNAVAILABLE" | "PROVIDER_QUERY_TIMEOUT" | "OPERATOR_CONFIRMED_UNKNOWN";
  readonly providerRequestIdHash?: string;
}

export interface ReconcileStartedResult {
  readonly encounterId: string;
  readonly ledgerEntryId: string;
  readonly resultStatus: "FAILED";
  readonly outcomeCode: string;
  readonly conservativeCostMinor: number;
  readonly invitationConsumed: boolean;
  readonly publicationReleased: boolean;
  readonly replayed: boolean;
}

export interface StaleStartedCursor { readonly staleAt: string; readonly executionClaimId: string; }
export interface StaleStartedCandidate extends StaleStartedCursor {
  readonly actorOwnerId: string;
  readonly encounterId: string;
  readonly startedAt: string;
}

export type InvitationStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export interface IssueInvitationInput {
  readonly initiatorTwinId: string;
  readonly responderTwinId: string;
  readonly initiatorSocialPersonaId: string;
  readonly responderSocialPersonaId: string;
  readonly initiatorIdentityVersionId: string;
  readonly responderIdentityVersionId: string;
  readonly purpose: string;
  readonly scope: "ONE_SHOT_ENCOUNTER";
  readonly contextHash: string;
  readonly expiresAt: string;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
}

export interface InvitationMutationResult {
  readonly invitationId: string;
  readonly status: InvitationStatus;
  readonly occurredAt: string;
  readonly replayed: boolean;
}

export interface InvitationListCursor { readonly createdAt:string; readonly invitationId:string; }
export interface OwnerInvitation {
  readonly invitationId: string;
  readonly status: InvitationStatus;
  readonly role: "INITIATOR" | "RESPONDER";
  readonly initiatorOwnerId: string;
  readonly initiatorTwinId: string;
  readonly responderOwnerId: string;
  readonly responderTwinId: string;
  readonly purpose: string;
  readonly scope: "ONE_SHOT_ENCOUNTER";
  readonly contextHash: string;
  readonly expiresAt: string;
  readonly claimedAt?: string;
  readonly usedAt?: string;
  readonly createdAt: string;
}

