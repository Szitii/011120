import { randomUUID } from "node:crypto";
import { contentHash } from "../companion-import/canonical.ts";
import { AuthorizationError, ConflictError, ImportPolicyError } from "../companion-import/errors.ts";
import type { CompanionIdentity } from "../companion-import/types.ts";
import type { IdentityProjectionSource, SocialProjectionRepository } from "./repository.ts";
import type {
  PrivateProjectionField,
  ProjectionAuditEvent,
  ProjectionManifestEntry,
  ProjectionResult,
  ProjectSocialTwinCommand,
  PublicProjectionField,
  SocialPersona,
  SocialRuntimeView,
  SocialTwin,
} from "./types.ts";

const allowedMappings: Readonly<Record<PrivateProjectionField, PublicProjectionField>> = Object.freeze({
  displayName: "displayName",
  identitySummary: "bio",
  personaTraits: "publicTraits",
  speakingStyle: "publicVoice",
  values: "publicInterests",
  boundaries: "publicBoundaries",
});

export class SocialProjectionError extends ImportPolicyError {
  override readonly name = "SocialProjectionError";
}

interface ProjectionDependencies {
  readonly identities: IdentityProjectionSource;
  readonly repository: SocialProjectionRepository;
  readonly now?: () => string;
  readonly id?: () => string;
}

function normalizeHandle(handle: string): string {
  const normalized = handle.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(normalized)) {
    throw new SocialProjectionError("SOCIAL_HANDLE_INVALID", "Handle must be 3–30 lowercase letters, numbers, or underscores.");
  }
  return normalized;
}

function identityValue(identity: CompanionIdentity, field: PrivateProjectionField): unknown {
  return identity[field];
}

export class SocialProjectionService {
  readonly #identities: IdentityProjectionSource;
  readonly #repository: SocialProjectionRepository;
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(dependencies: ProjectionDependencies) {
    this.#identities = dependencies.identities;
    this.#repository = dependencies.repository;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#id = dependencies.id ?? randomUUID;
  }

  projectAndActivate(command: ProjectSocialTwinCommand): ProjectionResult {
    const normalizedHandle = normalizeHandle(command.handle);
    const requestHash = contentHash({ ...command, handle: normalizedHandle, selections: [...command.selections] });
    const retry = this.#repository.findIdempotency(command.ownerId, command.idempotencyKey);
    if (retry !== undefined) {
      if (retry.requestHash !== requestHash) throw new ConflictError("Projection idempotency key was reused with a different request.");
      return retry.result;
    }

    if (command.idempotencyKey.trim() === "") {
      throw new SocialProjectionError("PROJECTION_IDEMPOTENCY_REQUIRED", "Projection idempotency key is required.");
    }
    const companion = this.#identities.findCompanionById(command.companionId);
    if (companion === undefined || companion.ownerId !== command.ownerId) throw new AuthorizationError();
    const identity = this.#identities.findIdentityById(command.sourceIdentityVersionId);
    const currentIdentity = this.#identities.findCurrentIdentity(command.companionId);
    if (identity === undefined || identity.companionId !== command.companionId) throw new AuthorizationError();
    if (currentIdentity?.id !== identity.id) {
      throw new ConflictError("A Social Persona may only project from the current approved identity version.");
    }

    const targetFields = new Set<PublicProjectionField>();
    const manifest: ProjectionManifestEntry[] = [];
    const projected = new Map<PublicProjectionField, unknown>();
    for (const selection of command.selections) {
      if (allowedMappings[selection.sourceField] !== selection.targetField) {
        throw new SocialProjectionError("PROJECTION_MAPPING_DENIED", "Projection mapping is not allowlisted.");
      }
      if (targetFields.has(selection.targetField)) {
        throw new SocialProjectionError("PROJECTION_TARGET_DUPLICATE", "A public field may be projected only once.");
      }
      const value = identityValue(identity, selection.sourceField);
      if (value === undefined) {
        throw new SocialProjectionError("PROJECTION_SOURCE_EMPTY", "A selected private identity field has no value.");
      }
      targetFields.add(selection.targetField);
      projected.set(selection.targetField, value);
      manifest.push(Object.freeze({
        ...selection,
        sourceValueHash: contentHash(value),
      }));
    }
    if (!targetFields.has("displayName")) {
      throw new SocialProjectionError("PROJECTION_DISPLAY_NAME_REQUIRED", "Display name requires an explicit projection selection.");
    }

    const handleOwner = this.#repository.findPersonaByHandle(normalizedHandle);
    if (handleOwner !== undefined && handleOwner.companionId !== command.companionId) {
      throw new ConflictError("Social handle is already in use.");
    }

    const existingTwin = this.#repository.findTwinByCompanionId(command.companionId);
    const previousPersona = this.#repository.findActivePersona(command.companionId);
    const timestamp = this.#now();
    const personaBody = {
      ownerId: command.ownerId,
      companionId: command.companionId,
      version: (previousPersona?.version ?? 0) + 1,
      handle: normalizedHandle,
      displayName: projected.get("displayName") as string,
      ...(typeof projected.get("bio") === "string" ? { bio: projected.get("bio") as string } : {}),
      publicTraits: (projected.get("publicTraits") as readonly string[] | undefined) ?? [],
      publicVoice: (projected.get("publicVoice") as Record<string, unknown> | undefined) ?? {},
      publicInterests: (projected.get("publicInterests") as readonly string[] | undefined) ?? [],
      publicBoundaries: (projected.get("publicBoundaries") as readonly string[] | undefined) ?? [],
      profileVisibility: command.profileVisibility,
      approvedByOwnerAt: timestamp,
      sourceIdentityVersionId: identity.id,
      sourceIdentityVersion: identity.version,
      sourceIdentityContentHash: identity.contentHash,
      projectionManifest: Object.freeze(manifest),
      ...(previousPersona === undefined ? {} : { supersedesSocialPersonaId: previousPersona.id }),
    };
    const persona: SocialPersona = Object.freeze({
      id: this.#id(),
      ...personaBody,
      contentHash: contentHash(personaBody),
    });
    const twin: SocialTwin = Object.freeze(existingTwin === undefined ? {
      id: this.#id(),
      ownerId: command.ownerId,
      companionId: command.companionId,
      activeSocialPersonaId: persona.id,
      status: "ACTIVE",
      autonomyMode: command.autonomyMode,
      socialMemoryNamespaceId: this.#id(),
      createdAt: timestamp,
      updatedAt: timestamp,
    } : {
      ...existingTwin,
      activeSocialPersonaId: persona.id,
      autonomyMode: command.autonomyMode,
      updatedAt: timestamp,
    });

    this.#repository.savePersona(persona);
    this.#repository.saveTwin(twin);
    const result = Object.freeze({ persona, twin });
    this.#repository.saveIdempotency(command.ownerId, command.idempotencyKey, Object.freeze({ requestHash, result }));
    this.#appendAudit(command.ownerId, command.companionId, "SOCIAL_PERSONA_PROJECTED", persona.id, persona.contentHash);
    this.#appendAudit(command.ownerId, command.companionId, "SOCIAL_PERSONA_ACTIVATED", twin.id, contentHash(twin));
    return result;
  }

  getRuntimeView(ownerId: string, socialTwinId: string): SocialRuntimeView {
    const twin = this.#repository.findTwinById(socialTwinId);
    if (twin === undefined || twin.ownerId !== ownerId) throw new AuthorizationError();
    const persona = this.#repository.findPersonaById(twin.activeSocialPersonaId);
    if (persona === undefined) throw new ConflictError("Social Twin has no active Social Persona.");
    return Object.freeze({
      principalType: "SOCIAL_TWIN",
      socialTwinId: twin.id,
      companionId: twin.companionId,
      socialPersonaId: persona.id,
      socialPersonaVersion: persona.version,
      handle: persona.handle,
      displayName: persona.displayName,
      ...(persona.bio === undefined ? {} : { bio: persona.bio }),
      publicTraits: persona.publicTraits,
      publicVoice: persona.publicVoice,
      publicInterests: persona.publicInterests,
      publicBoundaries: persona.publicBoundaries,
      socialMemoryNamespaceId: twin.socialMemoryNamespaceId,
    });
  }

  #appendAudit(
    ownerId: string,
    companionId: string,
    action: ProjectionAuditEvent["action"],
    targetId: string,
    afterHash: string,
  ): void {
    this.#repository.appendAudit(Object.freeze({
      id: this.#id(),
      ownerId,
      companionId,
      action,
      targetId,
      afterHash,
      occurredAt: this.#now(),
    }));
  }
}
