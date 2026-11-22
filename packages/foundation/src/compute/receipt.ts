import type { BillingParty, ReasonCode } from "./types.ts";

export interface ComputeReceipt {
  readonly transactionId: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly socialTwinId?: string;
  readonly reasonCode: ReasonCode;
  readonly triggerEventType: string;
  readonly triggerEventId: string;
  readonly providerId: string;
  readonly canonicalModel: string;
  readonly providerModel: string;
  readonly billingParty: BillingParty;
  readonly currency: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservedCostMinor: number;
  readonly actualCostMinor: number;
  readonly outcome: string;
  readonly promptTemplateVersion: string;
  readonly identityVersion: number;
  readonly socialPersonaVersion?: number;
  readonly memoryPolicyVersion: string;
  readonly safetyPolicyVersion: string;
  readonly routerVersion: string;
  readonly attemptNo: number;
}
