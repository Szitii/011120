import type { AuditEvent, Companion, CompanionIdentity, CompanionImportRecord } from "./types.ts";

export interface CompanionImportRepository {
  findImportById(id: string): CompanionImportRecord | undefined;
  findImportByIdempotency(ownerId: string, key: string): CompanionImportRecord | undefined;
  saveImport(record: CompanionImportRecord, idempotencyKey: string): void;
  updateImport(record: CompanionImportRecord): void;
  findApprovalByIdempotency(ownerId: string, key: string): ApprovalIdempotencyRecord | undefined;
  saveApprovalIdempotency(ownerId: string, key: string, record: ApprovalIdempotencyRecord): void;
  findCompanionById(id: string): Companion | undefined;
  saveCompanion(companion: Companion): void;
  updateCompanion(companion: Companion): void;
  findCurrentIdentity(companionId: string): CompanionIdentity | undefined;
  findIdentityById(id: string): CompanionIdentity | undefined;
  saveIdentity(identity: CompanionIdentity): void;
  appendAudit(event: AuditEvent): void;
  listAuditEvents(): readonly AuditEvent[];
}

export interface ApprovalIdempotencyRecord {
  readonly requestHash: string;
  readonly identity: CompanionIdentity;
}

export class InMemoryCompanionImportRepository implements CompanionImportRepository {
  readonly #imports = new Map<string, CompanionImportRecord>();
  readonly #importIdempotency = new Map<string, string>();
  readonly #approvalIdempotency = new Map<string, ApprovalIdempotencyRecord>();
  readonly #companions = new Map<string, Companion>();
  readonly #identities = new Map<string, CompanionIdentity>();
  readonly #auditEvents: AuditEvent[] = [];

  findImportById(id: string): CompanionImportRecord | undefined {
    return this.#imports.get(id);
  }

  findImportByIdempotency(ownerId: string, key: string): CompanionImportRecord | undefined {
    const id = this.#importIdempotency.get(`${ownerId}:${key}`);
    return id === undefined ? undefined : this.#imports.get(id);
  }

  saveImport(record: CompanionImportRecord, idempotencyKey: string): void {
    this.#imports.set(record.id, record);
    this.#importIdempotency.set(`${record.ownerId}:${idempotencyKey}`, record.id);
  }

  updateImport(record: CompanionImportRecord): void {
    this.#imports.set(record.id, record);
  }

  findApprovalByIdempotency(ownerId: string, key: string): ApprovalIdempotencyRecord | undefined {
    return this.#approvalIdempotency.get(`${ownerId}:${key}`);
  }

  saveApprovalIdempotency(ownerId: string, key: string, record: ApprovalIdempotencyRecord): void {
    this.#approvalIdempotency.set(`${ownerId}:${key}`, record);
  }

  findCompanionById(id: string): Companion | undefined {
    return this.#companions.get(id);
  }

  saveCompanion(companion: Companion): void {
    this.#companions.set(companion.id, companion);
  }

  updateCompanion(companion: Companion): void {
    this.#companions.set(companion.id, companion);
  }

  findCurrentIdentity(companionId: string): CompanionIdentity | undefined {
    const companion = this.#companions.get(companionId);
    return companion === undefined ? undefined : this.#identities.get(companion.currentIdentityVersionId);
  }

  findIdentityById(id: string): CompanionIdentity | undefined {
    return this.#identities.get(id);
  }

  saveIdentity(identity: CompanionIdentity): void {
    this.#identities.set(identity.id, identity);
  }

  appendAudit(event: AuditEvent): void {
    this.#auditEvents.push(Object.freeze(event));
  }

  listAuditEvents(): readonly AuditEvent[] {
    return Object.freeze([...this.#auditEvents]);
  }
}
