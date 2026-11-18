import { AuthorizationError, ConflictError } from "../companion-import/errors.ts";
import type { ComputeService } from "./service.ts";
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

export class ComputeReceiptService {
  readonly #compute: ComputeService;

  constructor(compute: ComputeService) {
    this.#compute = compute;
  }

  create(ownerId: string, transactionId: string): ComputeReceipt {
    const entries = this.#compute.transactionEntries(transactionId);
    const first = entries[0];
    if (first === undefined) throw new ConflictError("Compute transaction does not exist.");
    if (first.ownerId !== ownerId) throw new AuthorizationError();
    const settlement = [...entries].reverse().find((entry) => entry.entryType === "SETTLEMENT");
    const terminal = [...entries].reverse().find((entry) =>
      entry.entryType === "SETTLEMENT" || entry.entryType === "RELEASE" || entry.entryType === "REJECTION",
    );
    const actualCostMinor = entries.reduce((total, entry) =>
      total + (entry.entryType === "SETTLEMENT" ? entry.actualCostMinor : 0) + entry.costDeltaMinor,
    0);

    return Object.freeze({
      transactionId,
      ownerId: first.ownerId,
      companionId: first.companionId,
      ...(first.socialTwinId === undefined ? {} : { socialTwinId: first.socialTwinId }),
      reasonCode: first.reasonCode,
      triggerEventType: first.triggerEventType,
      triggerEventId: first.triggerEventId,
      providerId: first.providerId,
      canonicalModel: first.canonicalModel,
      providerModel: first.providerModel,
      billingParty: first.billingParty,
      currency: first.currency,
      inputTokens: settlement?.inputTokens ?? 0,
      outputTokens: settlement?.outputTokens ?? 0,
      reservedCostMinor: first.reservedCostMinor,
      actualCostMinor,
      outcome: terminal?.status ?? first.status,
      promptTemplateVersion: first.promptTemplateVersion,
      identityVersion: first.identityVersion,
      ...(first.socialPersonaVersion === undefined ? {} : { socialPersonaVersion: first.socialPersonaVersion }),
      memoryPolicyVersion: first.memoryPolicyVersion,
      safetyPolicyVersion: first.safetyPolicyVersion,
      routerVersion: first.routerVersion,
      attemptNo: first.attemptNo,
    });
  }
}
