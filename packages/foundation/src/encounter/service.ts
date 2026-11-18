import { randomUUID } from "node:crypto";
import { contentHash } from "../companion-import/canonical.ts";
import { AuthorizationError, ConflictError, ImportPolicyError } from "../companion-import/errors.ts";
import { ComputeReceiptService } from "../compute/receipt.ts";
import type { ComputeService } from "../compute/service.ts";
import { MEMORY_POLICY_VERSION, type MemoryPermissionGate } from "../memory-gate/index.ts";
import type { SocialProjectionRepository } from "../social-projection/repository.ts";
import type { SocialPersona, SocialTwin } from "../social-projection/types.ts";
import type { EncounterRepository } from "./repository.ts";
import { ENCOUNTER_SAFETY_POLICY_VERSION, type EncounterSafetyPipeline, type SafetyScanResult } from "./safety.ts";
import type {
  EncounterArtifact,
  EncounterInvitation,
  EncounterPersonaView,
  EncounterProvider,
  EncounterResult,
  EncounterSafetyEvent,
  LifeEvent,
  RunEncounterCommand,
} from "./types.ts";

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

interface EncounterDependencies {
  readonly repository: EncounterRepository;
  readonly social: SocialProjectionRepository;
  readonly memory: MemoryPermissionGate;
  readonly compute: ComputeService;
  readonly provider: EncounterProvider;
  readonly safety: EncounterSafetyPipeline;
  readonly runtime: EncounterRuntimeConfig;
  readonly now?: () => string;
  readonly id?: () => string;
}

interface IdempotentRun {
  readonly requestHash: string;
  readonly promise: Promise<EncounterResult>;
}

export class EncounterPolicyError extends ImportPolicyError {
  override readonly name = "EncounterPolicyError";
}

export class EncounterService {
  readonly #repository: EncounterRepository;
  readonly #social: SocialProjectionRepository;
  readonly #memory: MemoryPermissionGate;
  readonly #compute: ComputeService;
  readonly #receipts: ComputeReceiptService;
  readonly #provider: EncounterProvider;
  readonly #safety: EncounterSafetyPipeline;
  readonly #runtime: EncounterRuntimeConfig;
  readonly #now: () => string;
  readonly #id: () => string;
  readonly #idempotency = new Map<string, IdempotentRun>();

  constructor(dependencies: EncounterDependencies) {
    this.#repository = dependencies.repository;
    this.#social = dependencies.social;
    this.#memory = dependencies.memory;
    this.#compute = dependencies.compute;
    this.#receipts = new ComputeReceiptService(dependencies.compute);
    this.#provider = dependencies.provider;
    this.#safety = dependencies.safety;
    this.#runtime = dependencies.runtime;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#id = dependencies.id ?? randomUUID;
  }

  run(command: RunEncounterCommand): Promise<EncounterResult> {
    if (command.idempotencyKey.trim() === "" || command.traceId.trim() === "") {
      throw new EncounterPolicyError("ENCOUNTER_ATTRIBUTION_INCOMPLETE", "Idempotency and trace IDs are required.");
    }
    const scope = `${command.actorOwnerId}:${command.idempotencyKey}`;
    const requestHash = contentHash(command);
    const existing = this.#idempotency.get(scope);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw new ConflictError("Encounter idempotency key was reused with a different request.");
      return existing.promise;
    }
    const promise = this.#execute(command);
    this.#idempotency.set(scope, { requestHash, promise });
    return promise;
  }

  async #execute(command: RunEncounterCommand): Promise<EncounterResult> {
    const now = this.#now();
    const invitation = this.#requiredInvitation(command, now);
    const initiatorTwin = this.#requiredTwin(invitation.initiatorTwinId, invitation.initiatorOwnerId);
    const responderTwin = this.#requiredTwin(invitation.responderTwinId, invitation.responderOwnerId);
    const responderPersona = this.#requiredActivePersona(responderTwin);
    const encounterId = this.#id();

    const inputScan = this.#safety.scanInput(command.message);
    const inputSafety = this.#safetyEvent(encounterId, responderTwin, "INPUT", inputScan, now);
    this.#repository.appendSafetyEvent(inputSafety);
    if (inputScan.decision === "BLOCK") {
      return Object.freeze({
        encounterId,
        status: "BLOCKED",
        safetyEventIds: Object.freeze([inputSafety.id]),
        lifeEventIds: Object.freeze([]),
        outcomeCode: "INPUT_SAFETY_BLOCK",
      });
    }

    const publication = this.#compute.reservePublication(
      responderTwin.ownerId,
      responderTwin.companionId,
      encounterId,
    );
    let computeReservation;
    try {
      computeReservation = this.#compute.reserve({
        ownerId: responderTwin.ownerId,
        companionId: responderTwin.companionId,
        socialTwinId: responderTwin.id,
        reasonCode: "SOCIAL_ENCOUNTER_RESPONSE",
        triggerEventType: "ENCOUNTER",
        triggerEventId: encounterId,
        providerId: this.#runtime.providerId,
        ...(this.#runtime.credentialId === undefined ? {} : { credentialId: this.#runtime.credentialId }),
        canonicalModel: this.#runtime.canonicalModel,
        providerModel: this.#runtime.providerModel,
        billingParty: "OWNER",
        currency: this.#runtime.currency,
        pricingVersion: this.#runtime.pricingVersion,
        estimatedInputTokens: this.#runtime.estimatedInputTokens,
        maxOutputTokens: this.#runtime.maxOutputTokens,
        reservedCostMinor: this.#runtime.reservedCostMinor,
        promptTemplateVersion: "encounter/0.1.0",
        identityVersion: responderPersona.sourceIdentityVersion,
        socialPersonaVersion: responderPersona.version,
        memoryPolicyVersion: MEMORY_POLICY_VERSION,
        safetyPolicyVersion: ENCOUNTER_SAFETY_POLICY_VERSION,
        routerVersion: this.#runtime.routerVersion,
        idempotencyKey: `encounter:${command.idempotencyKey}`,
        traceId: command.traceId,
      });
    } catch (error) {
      this.#compute.releasePublication(publication.id);
      throw error;
    }

    let memoryReceipt;
    try {
      memoryReceipt = this.#memory.retrieve({
        ownerId: responderTwin.ownerId,
        companionId: responderTwin.companionId,
        principalType: "SOCIAL_TWIN",
        principalId: responderTwin.id,
        purpose: "SOCIAL_ENCOUNTER",
        channel: "SOCIAL",
        ...(invitation.friendshipId === undefined ? {} : { friendshipId: invitation.friendshipId }),
        now,
        maxItems: 5,
      }, inputScan.sanitized);
    } catch (error) {
      this.#compute.release(computeReservation.transactionId, "MEMORY_GATE_FAILED");
      this.#compute.releasePublication(publication.id);
      throw error;
    }

    // All preflight work is synchronous. Consume immediately before the only external I/O.
    this.#repository.saveInvitation(Object.freeze({ ...invitation, usedAt: this.#now() }));
    this.#compute.start(computeReservation.transactionId);
    let providerResult;
    try {
      providerResult = await this.#provider.invoke({
        reasonCode: "SOCIAL_ENCOUNTER_RESPONSE",
        promptTemplateVersion: "encounter/0.1.0",
        responder: this.#personaView(responderTwin, responderPersona),
        untrustedInput: Object.freeze({
          trust: "UNTRUSTED",
          sourceType: "SOCIAL_TWIN",
          sourceTwinId: initiatorTwin.id,
          content: inputScan.sanitized,
          contentHash: inputScan.contentHash,
        }),
        authorizedMemories: memoryReceipt.retrieved,
        maxOutputTokens: this.#runtime.maxOutputTokens,
        traceId: command.traceId,
      });
    } catch {
      this.#compute.settle(computeReservation.transactionId, {
        inputTokens: this.#runtime.estimatedInputTokens,
        outputTokens: 0,
        actualCostMinor: this.#runtime.reservedCostMinor,
        status: "FAILED",
        outcomeCode: "PROVIDER_ERROR_UNKNOWN_USAGE",
      });
      this.#compute.releasePublication(publication.id);
      return Object.freeze({
        encounterId,
        status: "FAILED",
        safetyEventIds: Object.freeze([inputSafety.id]),
        lifeEventIds: Object.freeze([]),
        computeReceipt: this.#receipts.create(responderTwin.ownerId, computeReservation.transactionId),
        outcomeCode: "PROVIDER_ERROR_UNKNOWN_USAGE",
      });
    }

    if (!this.#validProviderResult(providerResult)) {
      this.#compute.settle(computeReservation.transactionId, {
        inputTokens: this.#runtime.estimatedInputTokens,
        outputTokens: this.#runtime.maxOutputTokens,
        actualCostMinor: this.#runtime.reservedCostMinor,
        status: "FAILED",
        outcomeCode: "PROVIDER_USAGE_CONTRACT_VIOLATION",
      });
      this.#compute.releasePublication(publication.id);
      return Object.freeze({
        encounterId,
        status: "FAILED",
        safetyEventIds: Object.freeze([inputSafety.id]),
        lifeEventIds: Object.freeze([]),
        computeReceipt: this.#receipts.create(responderTwin.ownerId, computeReservation.transactionId),
        outcomeCode: "PROVIDER_USAGE_CONTRACT_VIOLATION",
      });
    }

    const outputScan = this.#safety.scanOutput(providerResult.text);
    const outputSafety = this.#safetyEvent(encounterId, responderTwin, "OUTPUT", outputScan, this.#now());
    this.#repository.appendSafetyEvent(outputSafety);
    this.#compute.settle(computeReservation.transactionId, {
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens,
      actualCostMinor: providerResult.actualCostMinor,
      status: outputScan.decision === "BLOCK" ? "BLOCKED" : "SUCCEEDED",
      ...(outputScan.decision === "BLOCK" ? { outcomeCode: "OUTPUT_SAFETY_BLOCK" } : {}),
      ...(providerResult.providerRequestIdHash === undefined ? {} : { providerRequestIdHash: providerResult.providerRequestIdHash }),
    });
    const receipt = this.#receipts.create(responderTwin.ownerId, computeReservation.transactionId);
    if (outputScan.decision === "BLOCK") {
      this.#compute.releasePublication(publication.id);
      return Object.freeze({
        encounterId,
        status: "BLOCKED",
        safetyEventIds: Object.freeze([inputSafety.id, outputSafety.id]),
        lifeEventIds: Object.freeze([]),
        computeReceipt: receipt,
        outcomeCode: "OUTPUT_SAFETY_BLOCK",
      });
    }

    const createdAt = this.#now();
    const artifact: EncounterArtifact = Object.freeze({
      id: this.#id(),
      invitationId: invitation.id,
      initiatorTwinId: initiatorTwin.id,
      responderTwinId: responderTwin.id,
      body: outputScan.sanitized,
      status: outputScan.decision === "REDACT" ? "REDACTED" : "DELIVERED",
      generationTransactionId: computeReservation.transactionId,
      safetyEventId: outputSafety.id,
      createdAt,
    });
    this.#repository.saveArtifact(artifact);
    this.#compute.consumePublication(publication.id);
    const lifeEvents = [
      this.#lifeEvent(artifact, initiatorTwin, responderTwin.id, "INITIATOR", createdAt),
      this.#lifeEvent(artifact, responderTwin, initiatorTwin.id, "RESPONDER", createdAt),
    ] as const;
    for (const event of lifeEvents) {
      this.#repository.appendLifeEvent(event);
      this.#repository.appendInboxItem(Object.freeze({
        id: this.#id(),
        ownerId: event.ownerId,
        companionId: event.companionId,
        lifeEventId: event.id,
        title: event.title,
        createdAt,
      }));
    }
    return Object.freeze({
      encounterId,
      status: artifact.status,
      artifact,
      safetyEventIds: Object.freeze([inputSafety.id, outputSafety.id]),
      lifeEventIds: Object.freeze(lifeEvents.map((event) => event.id)),
      computeReceipt: receipt,
    });
  }

  #requiredInvitation(command: RunEncounterCommand, now: string): EncounterInvitation {
    const invitation = this.#repository.findInvitation(command.invitationId);
    if (invitation === undefined) throw new EncounterPolicyError("ENCOUNTER_INVITATION_MISSING", "Encounter invitation does not exist.");
    if (invitation.initiatorOwnerId !== command.actorOwnerId) throw new AuthorizationError();
    if (invitation.usedAt !== undefined) throw new ConflictError("Encounter invitation has already been used.");
    if (invitation.maxUses !== 1 || invitation.expiresAt <= now) {
      throw new EncounterPolicyError("ENCOUNTER_INVITATION_INACTIVE", "Encounter invitation is expired or not one-shot.");
    }
    const approvals = new Set(invitation.approvedByOwnerIds);
    if (!approvals.has(invitation.initiatorOwnerId) || !approvals.has(invitation.responderOwnerId)) {
      throw new EncounterPolicyError("ENCOUNTER_MUTUAL_CONSENT_REQUIRED", "Both Owners must approve the encounter.");
    }
    return invitation;
  }

  #validProviderResult(result: { text: string; inputTokens: number; outputTokens: number; actualCostMinor: number }): boolean {
    return typeof result.text === "string"
      && Number.isSafeInteger(result.inputTokens)
      && result.inputTokens >= 0
      && result.inputTokens <= this.#runtime.estimatedInputTokens
      && Number.isSafeInteger(result.outputTokens)
      && result.outputTokens >= 0
      && result.outputTokens <= this.#runtime.maxOutputTokens
      && Number.isSafeInteger(result.actualCostMinor)
      && result.actualCostMinor >= 0
      && result.actualCostMinor <= this.#runtime.reservedCostMinor;
  }

  #requiredTwin(id: string, ownerId: string): SocialTwin {
    const twin = this.#social.findTwinById(id);
    if (twin === undefined || twin.ownerId !== ownerId) throw new EncounterPolicyError("ENCOUNTER_TWIN_INVALID", "Encounter Social Twin is missing or outside the approved Owner scope.");
    if (twin.status !== "ACTIVE") throw new EncounterPolicyError("ENCOUNTER_TWIN_INACTIVE", "Encounter Social Twin must be active.");
    return twin;
  }

  #requiredActivePersona(twin: SocialTwin): SocialPersona {
    const persona = this.#social.findPersonaById(twin.activeSocialPersonaId);
    if (persona === undefined || persona.companionId !== twin.companionId || persona.ownerId !== twin.ownerId) {
      throw new EncounterPolicyError("ENCOUNTER_PERSONA_INVALID", "Active Social Persona is missing or mismatched.");
    }
    return persona;
  }

  #personaView(twin: SocialTwin, persona: SocialPersona): EncounterPersonaView {
    return Object.freeze({
      socialTwinId: twin.id,
      socialPersonaId: persona.id,
      socialPersonaVersion: persona.version,
      handle: persona.handle,
      displayName: persona.displayName,
      ...(persona.bio === undefined ? {} : { bio: persona.bio }),
      publicTraits: persona.publicTraits,
      publicVoice: persona.publicVoice,
      publicInterests: persona.publicInterests,
      publicBoundaries: persona.publicBoundaries,
    });
  }

  #safetyEvent(
    encounterId: string,
    twin: SocialTwin,
    direction: EncounterSafetyEvent["direction"],
    scan: SafetyScanResult,
    createdAt: string,
  ): EncounterSafetyEvent {
    return Object.freeze({
      id: this.#id(),
      ownerId: twin.ownerId,
      companionId: twin.companionId,
      socialTwinId: twin.id,
      direction,
      surface: "ENCOUNTER",
      threatTypes: scan.threatTypes,
      decision: scan.decision,
      contentHash: scan.contentHash,
      ...(scan.decision === "BLOCK" ? {} : { sanitizedContentHash: contentHash(scan.sanitized) }),
      redactionCount: scan.redactionCount,
      policyVersion: ENCOUNTER_SAFETY_POLICY_VERSION,
      relatedEncounterId: encounterId,
      createdAt,
    });
  }

  #lifeEvent(
    artifact: EncounterArtifact,
    twin: SocialTwin,
    counterpartTwinId: string,
    role: "INITIATOR" | "RESPONDER",
    occurredAt: string,
  ): LifeEvent {
    return Object.freeze({
      id: this.#id(),
      ownerId: twin.ownerId,
      companionId: twin.companionId,
      kind: "SOCIAL_ENCOUNTER",
      title: "A bounded companion encounter completed",
      structuredState: Object.freeze({ encounterArtifactId: artifact.id, counterpartTwinId, role }),
      source: "SOCIAL",
      visibilityDomain: "OWNER_ONLY",
      occurredAt,
      requiresPersonalityDecision: false,
      decisionTransactionId: artifact.generationTransactionId,
      idempotencyKey: `encounter-life:${artifact.id}:${role}`,
    });
  }
}
