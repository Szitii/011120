import type { Companion, CompanionIdentity } from "../companion-import/types.ts";
import type {
  ProjectionAuditEvent,
  ProjectionResult,
  SocialPersona,
  SocialTwin,
} from "./types.ts";

export interface IdentityProjectionSource {
  findCompanionById(id: string): Companion | undefined;
  findIdentityById(id: string): CompanionIdentity | undefined;
  findCurrentIdentity(companionId: string): CompanionIdentity | undefined;
}

export interface ProjectionIdempotencyRecord {
  readonly requestHash: string;
  readonly result: ProjectionResult;
}

export interface SocialProjectionRepository {
  findTwinByCompanionId(companionId: string): SocialTwin | undefined;
  findTwinById(id: string): SocialTwin | undefined;
  findPersonaById(id: string): SocialPersona | undefined;
  findActivePersona(companionId: string): SocialPersona | undefined;
  findPersonaByHandle(handle: string): SocialPersona | undefined;
  savePersona(persona: SocialPersona): void;
  saveTwin(twin: SocialTwin): void;
  findIdempotency(ownerId: string, key: string): ProjectionIdempotencyRecord | undefined;
  saveIdempotency(ownerId: string, key: string, record: ProjectionIdempotencyRecord): void;
  appendAudit(event: ProjectionAuditEvent): void;
  listAuditEvents(): readonly ProjectionAuditEvent[];
}

export class InMemorySocialProjectionRepository implements SocialProjectionRepository {
  readonly #personas = new Map<string, SocialPersona>();
  readonly #twinsByCompanion = new Map<string, SocialTwin>();
  readonly #twinsById = new Map<string, SocialTwin>();
  readonly #personaByHandle = new Map<string, SocialPersona>();
  readonly #idempotency = new Map<string, ProjectionIdempotencyRecord>();
  readonly #audit: ProjectionAuditEvent[] = [];

  findTwinByCompanionId(companionId: string): SocialTwin | undefined {
    return this.#twinsByCompanion.get(companionId);
  }

  findTwinById(id: string): SocialTwin | undefined {
    return this.#twinsById.get(id);
  }

  findPersonaById(id: string): SocialPersona | undefined {
    return this.#personas.get(id);
  }

  findActivePersona(companionId: string): SocialPersona | undefined {
    const twin = this.#twinsByCompanion.get(companionId);
    return twin === undefined ? undefined : this.#personas.get(twin.activeSocialPersonaId);
  }

  findPersonaByHandle(handle: string): SocialPersona | undefined {
    return this.#personaByHandle.get(handle);
  }

  savePersona(persona: SocialPersona): void {
    this.#personas.set(persona.id, persona);
    this.#personaByHandle.set(persona.handle, persona);
  }

  saveTwin(twin: SocialTwin): void {
    this.#twinsByCompanion.set(twin.companionId, twin);
    this.#twinsById.set(twin.id, twin);
  }

  findIdempotency(ownerId: string, key: string): ProjectionIdempotencyRecord | undefined {
    return this.#idempotency.get(`${ownerId}:${key}`);
  }

  saveIdempotency(ownerId: string, key: string, record: ProjectionIdempotencyRecord): void {
    this.#idempotency.set(`${ownerId}:${key}`, record);
  }

  appendAudit(event: ProjectionAuditEvent): void {
    this.#audit.push(Object.freeze(event));
  }

  listAuditEvents(): readonly ProjectionAuditEvent[] {
    return Object.freeze([...this.#audit]);
  }
}
