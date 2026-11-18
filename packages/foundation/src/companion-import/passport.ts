import { contentHash } from "./canonical.ts";
import type { Companion, CompanionIdentity, IdentityPassport } from "./types.ts";

export function createIdentityPassport(
  companion: Companion,
  identity: CompanionIdentity,
): IdentityPassport {
  const body = {
    schema: "companion-social.identity-passport" as const,
    schemaVersion: "0.1" as const,
    companionId: companion.id,
    identityVersion: identity.version,
    identityContentHash: identity.contentHash,
    displayName: identity.displayName,
    ...(identity.identitySummary === undefined ? {} : { identitySummary: identity.identitySummary }),
    personaTraits: identity.personaTraits,
    speakingStyle: identity.speakingStyle,
    values: identity.values,
    boundaries: identity.boundaries,
    aspirations: identity.aspirations,
    appearance: identity.appearance,
    ...(identity.pronouns === undefined ? {} : { pronouns: identity.pronouns }),
    ...(identity.togetherSince === undefined ? {} : { togetherSince: identity.togetherSince }),
    provenance: {
      originType: companion.originType,
      originalSha256: identity.sourceManifest.originalSha256,
      parserVersion: identity.sourceManifest.parserVersion,
      policyVersion: identity.sourceManifest.policyVersion,
      approvedAt: identity.approvedByOwnerAt,
    },
    capabilityClaims: {
      executableInstructionsIncluded: false as const,
      privateMemoryIncluded: false as const,
      providerCredentialsIncluded: false as const,
      socialRuntimeAuthority: false as const,
    },
  };

  return Object.freeze({ ...body, passportHash: contentHash(body) });
}
