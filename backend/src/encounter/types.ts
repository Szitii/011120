import type { AssembledEncounterContext } from "../persistence/postgres/types.ts";

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
  readonly authorizedMemories: AssembledEncounterContext["authorizedMemories"];
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

export interface EncounterRuntimeConfig {
  readonly providerId: string;
  readonly credentialId?: string;
  readonly canonicalModel: string;
  readonly providerModel: string;
  readonly currency: string;
  readonly pricingVersion: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedCostMinor: number;
  readonly routerVersion: string;
}
