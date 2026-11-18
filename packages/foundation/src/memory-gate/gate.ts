import { contentHash } from "../companion-import/canonical.ts";
import { ImportPolicyError } from "../companion-import/errors.ts";
import type { MemoryRepository } from "./repository.ts";
import type {
  DisclosureLevel,
  MemoryAccessContext,
  MemoryAccessDecision,
  MemoryDecisionReceipt,
  MemoryDescriptor,
  MemoryPermission,
} from "./types.ts";

export const MEMORY_POLICY_VERSION = "memory-permission-policy/0.1.0";

const disclosureRank: Readonly<Record<DisclosureLevel, number>> = Object.freeze({
  PRESENCE_ONLY: 0,
  SUMMARY: 1,
  FULL: 2,
});

function matchingGrant(permission: MemoryPermission, context: MemoryAccessContext): boolean {
  if (permission.purpose !== context.purpose || permission.grantedByOwnerId !== context.ownerId) return false;
  if (permission.expiresAt !== undefined && permission.expiresAt <= context.now) return false;
  if (context.principalType === "PRIVATE_COMPANION_RUNTIME") {
    return permission.granteeType === "COMPANION_PRIVATE_RUNTIME" && permission.granteeId === context.principalId;
  }
  if (permission.granteeType === "SOCIAL_TWIN" && permission.granteeId === context.principalId) return true;
  return permission.granteeType === "FRIENDSHIP" && permission.granteeId === context.friendshipId;
}

function leastDisclosure(permissions: readonly MemoryPermission[]): DisclosureLevel {
  return permissions.reduce<DisclosureLevel>((least, permission) =>
    disclosureRank[permission.maxDisclosure] < disclosureRank[least] ? permission.maxDisclosure : least,
  "FULL");
}

function decide(
  memory: MemoryDescriptor,
  permissions: readonly MemoryPermission[],
  context: MemoryAccessContext,
): MemoryAccessDecision {
  if (memory.ownerId !== context.ownerId || memory.companionId !== context.companionId) {
    return Object.freeze({ memoryId: memory.id, decision: "DENY", ruleIds: Object.freeze(["SCOPE_MISMATCH"]) });
  }
  if (memory.revokedAt !== undefined || (memory.validUntil !== undefined && memory.validUntil <= context.now)) {
    return Object.freeze({ memoryId: memory.id, decision: "DENY", ruleIds: Object.freeze(["MEMORY_INACTIVE"]) });
  }

  const applicable = permissions.filter((permission) => matchingGrant(permission, context));
  if (applicable.some((permission) => permission.effect === "DENY")) {
    return Object.freeze({ memoryId: memory.id, decision: "DENY", ruleIds: Object.freeze(["EXPLICIT_DENY_OVERRIDES"]) });
  }
  const allows = applicable.filter((permission) => permission.effect === "ALLOW");

  if (context.principalType === "SOCIAL_TWIN") {
    if (context.channel !== "SOCIAL" || memory.namespace !== "SOCIAL") {
      return Object.freeze({ memoryId: memory.id, decision: "DENY", ruleIds: Object.freeze(["SOCIAL_NAMESPACE_ONLY"]) });
    }
    if (memory.domain === "OWNER_ONLY" || memory.domain === "COMPANION_PRIVATE" || memory.domain === "RELATIONSHIP_PRIVATE") {
      return Object.freeze({ memoryId: memory.id, decision: "DENY", ruleIds: Object.freeze(["PRIVATE_DOMAIN_HARD_DENY"]) });
    }
    if (memory.domain === "SOCIAL" || memory.domain === "PUBLIC") {
      return Object.freeze({ memoryId: memory.id, decision: "ALLOW", ruleIds: Object.freeze(["SOCIAL_DOMAIN_ALLOW"]), maxDisclosure: "FULL" });
    }
  } else {
    if (context.channel !== "PRIVATE" || memory.namespace !== "PRIVATE") {
      return Object.freeze({ memoryId: memory.id, decision: "DENY", ruleIds: Object.freeze(["PRIVATE_NAMESPACE_ONLY"]) });
    }
    if (memory.domain === "OWNER_ONLY") {
      return Object.freeze({ memoryId: memory.id, decision: "DENY", ruleIds: Object.freeze(["OWNER_ONLY_HARD_DENY"]) });
    }
  }

  if (allows.length === 0) {
    return Object.freeze({ memoryId: memory.id, decision: "DENY", ruleIds: Object.freeze(["NO_APPLICABLE_ALLOW"]) });
  }
  const maxDisclosure = leastDisclosure(allows);
  return Object.freeze({
    memoryId: memory.id,
    decision: maxDisclosure === "FULL" ? "ALLOW" : "ALLOW_REDACTED",
    ruleIds: Object.freeze(["PURPOSE_BOUND_ALLOW", `MAX_${maxDisclosure}`]),
    maxDisclosure,
  });
}

export class MemoryPermissionGate {
  readonly repository: MemoryRepository;

  constructor(repository: MemoryRepository) {
    this.repository = repository;
  }

  explain(context: MemoryAccessContext): MemoryDecisionReceipt {
    this.#validateContext(context);
    const namespace = context.principalType === "SOCIAL_TWIN" ? "SOCIAL" : "PRIVATE";
    const descriptors = this.repository.listDescriptors(context.ownerId, context.companionId, namespace);
    const permissions = this.repository.listPermissions(descriptors.map((descriptor) => descriptor.id));
    const decisions = descriptors.map((descriptor) => decide(
      descriptor,
      permissions.filter((permission) => permission.memoryId === descriptor.id),
      context,
    ));
    return Object.freeze({
      policyVersion: MEMORY_POLICY_VERSION,
      contextHash: contentHash(context),
      decisions: Object.freeze(decisions),
      retrieved: Object.freeze([]),
    });
  }

  retrieve(context: MemoryAccessContext, query: string): MemoryDecisionReceipt {
    const explained = this.explain(context);
    const allowed = explained.decisions.filter((decision) => decision.decision !== "DENY");
    const disclosureById = new Map(allowed.map((decision) => [decision.memoryId, decision.maxDisclosure ?? "FULL"]));
    const retrieved = allowed.length === 0 ? [] : this.repository.searchAuthorized({
      authorizedIds: allowed.map((decision) => decision.memoryId),
      disclosureById,
      query,
      maxItems: context.maxItems,
    });
    return Object.freeze({ ...explained, retrieved: Object.freeze(retrieved) });
  }

  #validateContext(context: MemoryAccessContext): void {
    if (context.maxItems < 1 || context.maxItems > 20) {
      throw new ImportPolicyError("MEMORY_RETRIEVAL_LIMIT_INVALID", "Memory retrieval limit must be between 1 and 20.");
    }
    if (context.principalType === "PRIVATE_COMPANION_RUNTIME" && context.principalId !== context.companionId) {
      throw new ImportPolicyError("MEMORY_PRINCIPAL_INVALID", "Private runtime principal must match the Companion.");
    }
  }
}
