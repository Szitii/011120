import type { ReasonCode, ReasonPolicy } from "./types.ts";

export const REASON_REGISTRY_VERSION = "compute-reasons/0.1.0";

export const REASON_POLICIES: Readonly<Record<ReasonCode, ReasonPolicy>> = Object.freeze({
  IMPORT_IDENTITY_SUMMARY: Object.freeze({ reasonCode: "IMPORT_IDENTITY_SUMMARY", billingParty: "OWNER", maxInputTokens: 8_000, maxOutputTokens: 1_000, maxReservedCostMinor: 100, publicOutput: false }),
  MEMORY_CONSOLIDATION: Object.freeze({ reasonCode: "MEMORY_CONSOLIDATION", billingParty: "OWNER", maxInputTokens: 8_000, maxOutputTokens: 1_000, maxReservedCostMinor: 100, publicOutput: false }),
  OWNER_DIRECT_RESPONSE: Object.freeze({ reasonCode: "OWNER_DIRECT_RESPONSE", billingParty: "OWNER", maxInputTokens: 16_000, maxOutputTokens: 2_000, maxReservedCostMinor: 200, publicOutput: false }),
  SOCIAL_ENCOUNTER_RESPONSE: Object.freeze({ reasonCode: "SOCIAL_ENCOUNTER_RESPONSE", billingParty: "OWNER", maxInputTokens: 4_000, maxOutputTokens: 800, maxReservedCostMinor: 100, publicOutput: true }),
  LIFE_EVENT_EXPRESSION: Object.freeze({ reasonCode: "LIFE_EVENT_EXPRESSION", billingParty: "OWNER", maxInputTokens: 4_000, maxOutputTokens: 800, maxReservedCostMinor: 100, publicOutput: false }),
  SAFETY_CLASSIFICATION: Object.freeze({ reasonCode: "SAFETY_CLASSIFICATION", billingParty: "PLATFORM", maxInputTokens: 4_000, maxOutputTokens: 200, maxReservedCostMinor: 50, publicOutput: false }),
  DLP_CLASSIFICATION: Object.freeze({ reasonCode: "DLP_CLASSIFICATION", billingParty: "PLATFORM", maxInputTokens: 4_000, maxOutputTokens: 200, maxReservedCostMinor: 50, publicOutput: false }),
});
