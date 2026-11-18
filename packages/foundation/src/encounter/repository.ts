import type {
  EncounterArtifact,
  EncounterInvitation,
  EncounterSafetyEvent,
  LifeEvent,
  LifeEventInboxItem,
} from "./types.ts";

export interface EncounterRepository {
  findInvitation(id: string): EncounterInvitation | undefined;
  saveInvitation(invitation: EncounterInvitation): void;
  saveArtifact(artifact: EncounterArtifact): void;
  appendSafetyEvent(event: EncounterSafetyEvent): void;
  appendLifeEvent(event: LifeEvent): void;
  appendInboxItem(item: LifeEventInboxItem): void;
  listArtifacts(): readonly EncounterArtifact[];
  listSafetyEvents(): readonly EncounterSafetyEvent[];
  listLifeEvents(ownerId: string): readonly LifeEvent[];
  listInbox(ownerId: string): readonly LifeEventInboxItem[];
}

export class InMemoryEncounterRepository implements EncounterRepository {
  readonly #invitations = new Map<string, EncounterInvitation>();
  readonly #artifacts: EncounterArtifact[] = [];
  readonly #safetyEvents: EncounterSafetyEvent[] = [];
  readonly #lifeEvents: LifeEvent[] = [];
  readonly #inbox: LifeEventInboxItem[] = [];

  findInvitation(id: string): EncounterInvitation | undefined {
    return this.#invitations.get(id);
  }

  saveInvitation(invitation: EncounterInvitation): void {
    this.#invitations.set(invitation.id, Object.freeze(invitation));
  }

  saveArtifact(artifact: EncounterArtifact): void {
    this.#artifacts.push(Object.freeze(artifact));
  }

  appendSafetyEvent(event: EncounterSafetyEvent): void {
    this.#safetyEvents.push(Object.freeze(event));
  }

  appendLifeEvent(event: LifeEvent): void {
    this.#lifeEvents.push(Object.freeze(event));
  }

  appendInboxItem(item: LifeEventInboxItem): void {
    this.#inbox.push(Object.freeze(item));
  }

  listArtifacts(): readonly EncounterArtifact[] {
    return Object.freeze([...this.#artifacts]);
  }

  listSafetyEvents(): readonly EncounterSafetyEvent[] {
    return Object.freeze([...this.#safetyEvents]);
  }

  listLifeEvents(ownerId: string): readonly LifeEvent[] {
    return Object.freeze(this.#lifeEvents.filter((event) => event.ownerId === ownerId));
  }

  listInbox(ownerId: string): readonly LifeEventInboxItem[] {
    return Object.freeze(this.#inbox.filter((item) => item.ownerId === ownerId));
  }
}
