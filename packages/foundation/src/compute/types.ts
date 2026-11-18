export type ReasonCode =
  | "IMPORT_IDENTITY_SUMMARY"
  | "MEMORY_CONSOLIDATION"
  | "OWNER_DIRECT_RESPONSE"
  | "SOCIAL_ENCOUNTER_RESPONSE"
  | "LIFE_EVENT_EXPRESSION"
  | "SAFETY_CLASSIFICATION"
  | "DLP_CLASSIFICATION";

export type BillingParty = "OWNER" | "PLATFORM" | "PROMOTION";

export interface ReasonPolicy {
  readonly reasonCode: ReasonCode;
  readonly billingParty: BillingParty;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxReservedCostMinor: number;
  readonly publicOutput: boolean;
}

export interface ComputeBudgetDefinition {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly maxModelCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostMinor: number;
  readonly currency: string;
}

export interface ComputeBudgetSnapshot extends ComputeBudgetDefinition {
  readonly reservedCalls: number;
  readonly settledCalls: number;
  readonly reservedInputTokens: number;
  readonly settledInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly settledOutputTokens: number;
  readonly reservedCostMinor: number;
  readonly settledCostMinor: number;
}

export interface PublicationBudgetDefinition {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly maxPublications: number;
}

export interface PublicationBudgetSnapshot extends PublicationBudgetDefinition {
  readonly reservedPublications: number;
  readonly consumedPublications: number;
}

export interface ReserveComputeCommand {
  readonly ownerId: string;
  readonly companionId: string;
  readonly socialTwinId?: string;
  readonly reasonCode: ReasonCode;
  readonly triggerEventType: string;
  readonly triggerEventId: string;
  readonly providerId: string;
  readonly credentialId?: string;
  readonly canonicalModel: string;
  readonly providerModel: string;
  readonly billingParty: BillingParty;
  readonly currency: string;
  readonly pricingVersion: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedCostMinor: number;
  readonly promptTemplateVersion: string;
  readonly identityVersion: number;
  readonly socialPersonaVersion?: number;
  readonly memoryPolicyVersion: string;
  readonly safetyPolicyVersion: string;
  readonly routerVersion: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly attemptNo?: number;
  readonly retryParentTransactionId?: string;
}

export type ComputeLedgerEntryType =
  | "RESERVATION"
  | "REJECTION"
  | "START"
  | "SETTLEMENT"
  | "RELEASE"
  | "RECONCILIATION";

export interface ComputeLedgerEntry {
  readonly id: string;
  readonly transactionId: string;
  readonly sequence: number;
  readonly entryType: ComputeLedgerEntryType;
  readonly ownerId: string;
  readonly companionId: string;
  readonly socialTwinId?: string;
  readonly reasonCode: ReasonCode;
  readonly triggerEventType: string;
  readonly triggerEventId: string;
  readonly providerId: string;
  readonly credentialId?: string;
  readonly canonicalModel: string;
  readonly providerModel: string;
  readonly billingParty: BillingParty;
  readonly currency: string;
  readonly pricingVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservedCostMinor: number;
  readonly actualCostMinor: number;
  readonly costDeltaMinor: number;
  readonly promptTemplateVersion: string;
  readonly identityVersion: number;
  readonly socialPersonaVersion?: number;
  readonly memoryPolicyVersion: string;
  readonly safetyPolicyVersion: string;
  readonly routerVersion: string;
  readonly status: "RESERVED" | "REJECTED" | "STARTED" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED" | "RECONCILED";
  readonly outcomeCode?: string;
  readonly providerRequestIdHash?: string;
  readonly traceId: string;
  readonly attemptNo: number;
  readonly retryParentTransactionId?: string;
  readonly idempotencyKeyHash: string;
  readonly createdAt: string;
}

export interface ComputeReservation {
  readonly transactionId: string;
  readonly budgetId: string;
  readonly reservedCostMinor: number;
  readonly entry: ComputeLedgerEntry;
}

export interface ComputeSettlement {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly actualCostMinor: number;
  readonly status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  readonly outcomeCode?: string;
  readonly providerRequestIdHash?: string;
}

export interface PublicationReservation {
  readonly id: string;
  readonly budgetId: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly relatedEventId: string;
  readonly status: "RESERVED" | "CONSUMED" | "RELEASED";
}
