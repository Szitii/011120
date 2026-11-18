export type MemoryNamespace = "PRIVATE" | "SOCIAL";
export type MemoryDomain =
  | "OWNER_ONLY"
  | "COMPANION_PRIVATE"
  | "RELATIONSHIP_PRIVATE"
  | "FRIEND_SHAREABLE"
  | "SOCIAL"
  | "PUBLIC";
export type MemoryPurpose = "PRIVATE_CHAT" | "SOCIAL_POST" | "SOCIAL_ENCOUNTER" | "COMMENT_REPLY" | "DM" | "PROFILE" | "LIFE_EVENT" | "EXPORT";
export type DisclosureLevel = "PRESENCE_ONLY" | "SUMMARY" | "FULL";

export interface MemoryDescriptor {
  readonly id: string;
  readonly ownerId: string;
  readonly companionId: string;
  readonly namespace: MemoryNamespace;
  readonly domain: MemoryDomain;
  readonly sourceTrust: "OWNER_ASSERTED" | "PLATFORM_EVENT" | "MODEL_DERIVED" | "EXTERNAL_UNTRUSTED";
  readonly validUntil?: string;
  readonly revokedAt?: string;
}

export interface MemoryRecord extends MemoryDescriptor {
  readonly content: string;
  readonly summary: string;
}

export interface MemoryPermission {
  readonly id: string;
  readonly memoryId: string;
  readonly effect: "ALLOW" | "DENY";
  readonly granteeType: "COMPANION_PRIVATE_RUNTIME" | "SOCIAL_TWIN" | "FRIENDSHIP";
  readonly granteeId: string;
  readonly purpose: MemoryPurpose;
  readonly maxDisclosure: DisclosureLevel;
  readonly expiresAt?: string;
  readonly grantedByOwnerId: string;
}

export interface MemoryAccessContext {
  readonly ownerId: string;
  readonly companionId: string;
  readonly principalType: "PRIVATE_COMPANION_RUNTIME" | "SOCIAL_TWIN";
  readonly principalId: string;
  readonly purpose: MemoryPurpose;
  readonly channel: "PRIVATE" | "SOCIAL";
  readonly friendshipId?: string;
  readonly now: string;
  readonly maxItems: number;
}

export interface MemoryAccessDecision {
  readonly memoryId: string;
  readonly decision: "ALLOW" | "DENY" | "ALLOW_REDACTED";
  readonly ruleIds: readonly string[];
  readonly maxDisclosure?: DisclosureLevel;
}

export interface RetrievedMemory {
  readonly id: string;
  readonly representation: string;
  readonly disclosure: DisclosureLevel;
  readonly sourceTrust: MemoryDescriptor["sourceTrust"];
}

export interface MemoryDecisionReceipt {
  readonly policyVersion: string;
  readonly contextHash: string;
  readonly decisions: readonly MemoryAccessDecision[];
  readonly retrieved: readonly RetrievedMemory[];
}
