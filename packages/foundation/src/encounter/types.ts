import type { ComputeReceipt } from "../compute/receipt.ts";
import type { RetrievedMemory } from "../memory-gate/types.ts";

export interface EncounterInvitation {
  readonly id: string;
  readonly initiatorOwnerId: string;
  readonly initiatorTwinId: string;
  readonly responderOwnerId: string;
  readonly responderTwinId: string;
  readonly approvedByOwnerIds: readonly string[];
  readonly purpose: string;
  readonly friendshipId?: string;
  readonly maxUses: 1;
  readonly expiresAt: string;
  readonly usedAt?: string;
}

export interface RunEncounterCommand {
  readonly actorOwnerId: string;
  readonly invitationId: string;
  readonly message: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
}

export interface UntrustedSocialInput {
  readonly trust: "UNTRUSTED";
  readonly sourceType: "SOCIAL_TWIN";
  readonly sourceTwinId: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface EncounterPersonaView {
  readonly socialTwinId: string;
  readonly socialPersonaId: string;
  readonly socialPersonaVersion: number;
  readonly handle: string;
  readonly displayName: string;
  readonly bio?: string;
  readonly publicTraits: readonly string[];
  readonly publicVoice: Record<string, unknown>;
  readonly publicInterests: readonly string[];
  readonly publicBoundaries: readonly string[];
}

export interface EncounterProviderRequest {
  readonly reasonCode: "SOCIAL_ENCOUNTER_RESPONSE";
  readonly promptTemplateVersion: "encounter/0.1.0";
  readonly responder: EncounterPersonaView;
  readonly untrustedInput: UntrustedSocialInput;
  readonly authorizedMemories: readonly RetrievedMemory[];
  readonly maxOutputTokens: number;
  readonly traceId: string;
}

export interface EncounterProviderResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly actualCostMinor: number;
  readonly providerRequestIdHash?: string;
}

export interface EncounterProvider {
  invoke(request: EncounterProviderRequest): Promise<EncounterProviderResult>;
}

export interface EncounterArtifact {
  readonly id: string;
  readonly invitationId: string;
  readonly initiatorTwinId: string;
  readonly responderTwinId: string;
  readonly body: string;
  readonly status: "DELIVERED" | "REDACTED";
  readonly generationTransactionId: string;
  readonly safetyEventId: string;
  readonly createdAt: string;
}

export interface EncounterSafetyEvent {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly socialTwinId: string;
  readonly direction: "INPUT" | "OUTPUT";
  readonly surface: "ENCOUNTER";
  readonly threatTypes: readonly string[];
  readonly decision: "ALLOW" | "REDACT" | "BLOCK" | "LIMIT";
  readonly contentHash: string;
  readonly sanitizedContentHash?: string;
  readonly redactionCount: number;
  readonly policyVersion: string;
  readonly relatedEncounterId: string;
  readonly createdAt: string;
}

export interface LifeEvent {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly kind: "SOCIAL_ENCOUNTER";
  readonly title: string;
  readonly structuredState: {
    readonly encounterArtifactId: string;
    readonly counterpartTwinId: string;
    readonly role: "INITIATOR" | "RESPONDER";
  };
  readonly source: "SOCIAL";
  readonly visibilityDomain: "OWNER_ONLY";
  readonly occurredAt: string;
  readonly requiresPersonalityDecision: false;
  readonly decisionTransactionId: string;
  readonly idempotencyKey: string;
}

export interface LifeEventInboxItem {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly lifeEventId: string;
  readonly title: string;
  readonly readAt?: string;
  readonly createdAt: string;
}

export interface EncounterResult {
  readonly encounterId: string;
  readonly status: "DELIVERED" | "REDACTED" | "BLOCKED" | "FAILED";
  readonly artifact?: EncounterArtifact;
  readonly safetyEventIds: readonly string[];
  readonly lifeEventIds: readonly string[];
  readonly computeReceipt?: ComputeReceipt;
  readonly outcomeCode?: string;
}
