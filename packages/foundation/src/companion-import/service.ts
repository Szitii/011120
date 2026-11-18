import { randomUUID } from "node:crypto";
import { contentHash, sha256 } from "./canonical.ts";
import { AuthorizationError, ConflictError, ImportPolicyError } from "./errors.ts";
import { createIdentityPassport } from "./passport.ts";
import { parseCharacterCard, parserMetadata } from "./parser.ts";
import type { CompanionImportRepository } from "./repository.ts";
import type {
  ApproveImportCommand,
  AuditEvent,
  Companion,
  CompanionIdentity,
  CompanionImportRecord,
  CreateImportCommand,
  IdentityCandidate,
  IdentityPassport,
  ImportStatus,
  ImportReview,
} from "./types.ts";

export interface ServiceDependencies {
  readonly repository: CompanionImportRepository;
  readonly now?: () => string;
  readonly id?: () => string;
}

function asBytes(payload: Uint8Array | string): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : new Uint8Array(payload);
}

function transition(history: readonly ImportStatus[], next: ImportStatus): readonly ImportStatus[] {
  return Object.freeze([...history, next]);
}

function reviewOf(record: CompanionImportRecord): ImportReview {
  return Object.freeze({
    id: record.id,
    status: record.status,
    statusHistory: record.statusHistory,
    originalSha256: record.originalSha256,
    byteLength: record.byteLength,
    parserVersion: record.parserVersion,
    policyVersion: record.policyVersion,
    sourceFormat: record.sourceFormat,
    ...(record.draft === undefined ? {} : { draft: record.draft }),
    findings: record.findings,
    ...(record.rejectionCode === undefined ? {} : { rejectionCode: record.rejectionCode }),
    ...(record.approvedIdentityId === undefined ? {} : { approvedIdentityId: record.approvedIdentityId }),
  });
}

function valuesFor(candidates: readonly IdentityCandidate[]): Record<string, IdentityCandidate["value"]> {
  return Object.fromEntries(candidates.map((candidate) => [candidate.field, candidate.value]));
}

export class CompanionImportService {
  readonly #repository: CompanionImportRepository;
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(dependencies: ServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#id = dependencies.id ?? randomUUID;
  }

  createImport(command: CreateImportCommand): ImportReview {
    if (command.ownerId.trim() === "" || command.idempotencyKey.trim() === "") {
      throw new ImportPolicyError("IMPORT_COMMAND_INVALID", "Owner and idempotency key are required.");
    }

    const payload = asBytes(command.payload);
    const payloadHash = sha256(payload);
    const existing = this.#repository.findImportByIdempotency(command.ownerId, command.idempotencyKey);
    if (existing !== undefined) {
      if (existing.originalSha256 !== payloadHash) {
        throw new ConflictError("The idempotency key was already used with a different import payload.");
      }
      return reviewOf(existing);
    }

    const timestamp = this.#now();
    const importId = this.#id();
    const uploaded: CompanionImportRecord = Object.freeze({
      id: importId,
      ownerId: command.ownerId,
      status: "UPLOADED",
      statusHistory: transition([], "UPLOADED"),
      originalSha256: payloadHash,
      byteLength: payload.byteLength,
      parserVersion: parserMetadata.parserVersion,
      policyVersion: parserMetadata.policyVersion,
      sourceFormat: "UNKNOWN",
      createdAt: timestamp,
      updatedAt: timestamp,
      rawPayload: payload,
      findings: Object.freeze([]),
    });
    this.#repository.saveImport(uploaded, command.idempotencyKey);

    const quarantined: CompanionImportRecord = Object.freeze({
      ...uploaded,
      status: "QUARANTINED",
      statusHistory: transition(uploaded.statusHistory, "QUARANTINED"),
      updatedAt: this.#now(),
    });
    this.#repository.updateImport(quarantined);

    try {
      const parsed = parseCharacterCard(payload);
      const reviewable: CompanionImportRecord = Object.freeze({
        ...quarantined,
        status: "REVIEWABLE",
        statusHistory: transition(quarantined.statusHistory, "REVIEWABLE"),
        sourceFormat: parsed.sourceFormat,
        draft: parsed.draft,
        findings: parsed.findings,
        updatedAt: this.#now(),
      });
      this.#repository.updateImport(reviewable);
      this.#appendAudit(command.ownerId, "COMPANION_IMPORT_CREATED", "COMPANION_IMPORT", importId, payloadHash);
      return reviewOf(reviewable);
    } catch (error) {
      if (!(error instanceof ImportPolicyError)) throw error;
      const rejected: CompanionImportRecord = Object.freeze({
        ...quarantined,
        status: "REJECTED",
        statusHistory: transition(quarantined.statusHistory, "REJECTED"),
        rejectionCode: error.code,
        updatedAt: this.#now(),
      });
      this.#repository.updateImport(rejected);
      this.#appendAudit(command.ownerId, "COMPANION_IMPORT_REJECTED", "COMPANION_IMPORT", importId, payloadHash);
      return reviewOf(rejected);
    }
  }

  getImportReview(ownerId: string, importId: string): ImportReview {
    const record = this.#ownedImport(ownerId, importId);
    return reviewOf(record);
  }

  approveImport(command: ApproveImportCommand): CompanionIdentity {
    if (command.idempotencyKey.trim() === "") {
      throw new ImportPolicyError("APPROVAL_COMMAND_INVALID", "An approval idempotency key is required.");
    }
    const approvalRequestHash = contentHash({
      ownerId: command.ownerId,
      importId: command.importId,
      approvedCandidateIds: [...command.approvedCandidateIds].sort(),
      companionId: command.companionId ?? null,
    });
    const existingApproval = this.#repository.findApprovalByIdempotency(command.ownerId, command.idempotencyKey);
    if (existingApproval !== undefined) {
      if (existingApproval.requestHash !== approvalRequestHash) {
        throw new ConflictError("The approval idempotency key was already used for a different request.");
      }
      return existingApproval.identity;
    }

    const record = this.#ownedImport(command.ownerId, command.importId);
    if (record.status !== "REVIEWABLE" || record.draft === undefined) {
      throw new ConflictError("Only a reviewable import may be approved.");
    }

    const requestedIds = new Set(command.approvedCandidateIds);
    if (requestedIds.size !== command.approvedCandidateIds.length) {
      throw new ImportPolicyError("APPROVAL_DUPLICATE_CANDIDATE", "Candidate approvals must be unique.");
    }
    const candidateById = new Map(record.draft.candidates.map((candidate) => [candidate.id, candidate]));
    for (const id of requestedIds) {
      const selected = candidateById.get(id);
      if (selected === undefined) {
        throw new ImportPolicyError("APPROVAL_UNKNOWN_CANDIDATE", "Approval references an unknown candidate.");
      }
      if (!selected.approvable) {
        throw new ImportPolicyError("APPROVAL_BLOCKED_CANDIDATE", "A blocked candidate cannot be approved.");
      }
    }
    const approvedCandidates = record.draft.candidates.filter((candidate) => requestedIds.has(candidate.id));
    if (!approvedCandidates.some((candidate) => candidate.field === "displayName")) {
      throw new ImportPolicyError("APPROVAL_NAME_REQUIRED", "The display name candidate must be explicitly approved.");
    }

    const timestamp = this.#now();
    const companion = this.#resolveCompanion(command, timestamp);
    const currentIdentity = this.#repository.findCurrentIdentity(companion.id);
    const values = valuesFor(approvedCandidates);
    const identityBody = {
      companionId: companion.id,
      version: (currentIdentity?.version ?? 0) + 1,
      displayName: values.displayName as string,
      ...(typeof values.identitySummary === "string" ? { identitySummary: values.identitySummary } : {}),
      personaTraits: (values.personaTraits as readonly string[] | undefined) ?? [],
      speakingStyle: (values.speakingStyle as Record<string, unknown> | undefined) ?? {},
      values: (values.values as readonly string[] | undefined) ?? [],
      boundaries: (values.boundaries as readonly string[] | undefined) ?? [],
      aspirations: (values.aspirations as readonly string[] | undefined) ?? [],
      appearance: (values.appearance as Record<string, unknown> | undefined) ?? {},
      ...(typeof values.pronouns === "string" ? { pronouns: values.pronouns } : {}),
      ...(typeof values.togetherSince === "string" ? { togetherSince: values.togetherSince } : {}),
      sourceManifest: {
        importId: record.id,
        originalSha256: record.originalSha256,
        parserVersion: record.parserVersion,
        policyVersion: record.policyVersion,
        approvedCandidateIds: Object.freeze([...requestedIds].sort()),
      },
      createdBy: "IMPORT_FIREWALL" as const,
      approvedByOwnerAt: timestamp,
      ...(currentIdentity === undefined ? {} : { supersedesIdentityId: currentIdentity.id }),
    };
    const identity: CompanionIdentity = Object.freeze({
      id: this.#id(),
      ...identityBody,
      contentHash: contentHash(identityBody),
    });

    this.#repository.saveIdentity(identity);
    const updatedCompanion: Companion = Object.freeze({ ...companion, currentIdentityVersionId: identity.id });
    if (this.#repository.findCompanionById(companion.id) === undefined) {
      this.#repository.saveCompanion(updatedCompanion);
    } else {
      this.#repository.updateCompanion(updatedCompanion);
    }
    const approvedImport: CompanionImportRecord = Object.freeze({
      ...record,
      status: "APPROVED",
      statusHistory: transition(record.statusHistory, "APPROVED"),
      approvedIdentityId: identity.id,
      updatedAt: timestamp,
    });
    this.#repository.updateImport(approvedImport);
    this.#repository.saveApprovalIdempotency(command.ownerId, command.idempotencyKey, Object.freeze({
      requestHash: approvalRequestHash,
      identity,
    }));
    this.#appendAudit(command.ownerId, "COMPANION_IDENTITY_APPROVED", "COMPANION_IDENTITY", identity.id, identity.contentHash);
    return identity;
  }

  exportIdentityPassport(ownerId: string, companionId: string): IdentityPassport {
    const companion = this.#repository.findCompanionById(companionId);
    if (companion === undefined || companion.ownerId !== ownerId) throw new AuthorizationError();
    const identity = this.#repository.findCurrentIdentity(companionId);
    if (identity === undefined) throw new ConflictError("Companion has no active identity version.");
    return createIdentityPassport(companion, identity);
  }

  #resolveCompanion(command: ApproveImportCommand, timestamp: string): Companion {
    if (command.companionId !== undefined) {
      const existing = this.#repository.findCompanionById(command.companionId);
      if (existing === undefined || existing.ownerId !== command.ownerId) throw new AuthorizationError();
      return existing;
    }
    return Object.freeze({
      id: this.#id(),
      ownerId: command.ownerId,
      status: "ACTIVE",
      originType: "IMPORTED_CARD",
      currentIdentityVersionId: "PENDING",
      createdAt: timestamp,
    });
  }

  #ownedImport(ownerId: string, importId: string): CompanionImportRecord {
    const record = this.#repository.findImportById(importId);
    if (record === undefined || record.ownerId !== ownerId) throw new AuthorizationError();
    return record;
  }

  #appendAudit(
    ownerId: string,
    action: AuditEvent["action"],
    targetType: AuditEvent["targetType"],
    targetId: string,
    afterHash: string,
  ): void {
    this.#repository.appendAudit(Object.freeze({
      id: this.#id(),
      ownerId,
      action,
      targetType,
      targetId,
      afterHash,
      occurredAt: this.#now(),
    }));
  }
}
