import { createHash, randomUUID } from "node:crypto";
import { contentHash } from "../companion-import/canonical.ts";
import type { PostgresServerAdapter } from "../persistence/postgres/adapter.ts";
import type {
  AssembleEncounterContextInput,
  AssembledEncounterContext,
  ClaimEncounterInput,
  EncounterPreparation,
  PersistDeliveryInput,
  PersistNonDeliveryInput,
  RecordSafetyEventInput,
  ReserveComputeInput,
  ReservePublicationInput,
  SettleComputeInput,
} from "../persistence/postgres/types.ts";
import { ENCOUNTER_SAFETY_POLICY_VERSION, type EncounterSafetyPipeline } from "./safety.ts";
import type { EncounterPersonaView, EncounterProvider, EncounterRuntimeConfig } from "./types.ts";

const PROMPT_TEMPLATE_VERSION = "encounter/0.1.0";
const DEFAULT_MAX_MEMORIES = 5;
const PREFLIGHT_FAILED = "ENCOUNTER_PREFLIGHT_FAILED";

// Idempotency and request hashes are persisted: the key order of every hashed object is part of the contract.
const hash = (value: unknown): string =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

type TerminalStatus = "BLOCKED" | "FAILED" | "DELIVERED" | "REDACTED";
type InputScan = ReturnType<EncounterSafetyPipeline["scanInput"]>;

export interface EncounterPersistencePort {
  getEncounterTerminal(
    actorOwnerId: string,
    idempotencyKeyHash: string,
    requestHash: string,
  ): Promise<{ encounterId: string; resultStatus: TerminalStatus; outcomeCode?: string } | undefined>;
  getEncounterPreparation(actorOwnerId: string, invitationId: string): Promise<EncounterPreparation>;
  assembleEncounterContext(input: AssembleEncounterContextInput): Promise<AssembledEncounterContext>;
  recordSafetyEvent(input: RecordSafetyEventInput): Promise<string>;
  reservePublication(input: ReservePublicationInput): Promise<{ reservationId: string; decision: string }>;
  reserveCompute(input: ReserveComputeInput): Promise<{ transactionId: string; decision: string }>;
  claimEncounter(
    input: ClaimEncounterInput,
  ): Promise<{ executionClaimId: string; encounterId: string; replayed: boolean }>;
  startCompute(ownerId: string, transactionId: string): Promise<{ decision: string }>;
  releaseCompute(ownerId: string, transactionId: string, outcomeCode: string): Promise<unknown>;
  releasePublication(ownerId: string, reservationId: string, outcomeCode: string): Promise<void>;
  settleCompute(input: SettleComputeInput): Promise<unknown>;
  persistNonDelivery(
    input: PersistNonDeliveryInput,
  ): Promise<{ resultStatus: "BLOCKED" | "FAILED"; outcomeCode: string; replayed: boolean }>;
  persistDelivery(input: PersistDeliveryInput): Promise<{ resultStatus: "DELIVERED" | "REDACTED"; replayed: boolean }>;
}

export interface PersistentEncounterCommand {
  readonly actorOwnerId: string;
  readonly invitationId: string;
  readonly encounterId: string;
  readonly message: string;
  readonly maxMemories?: number;
  readonly idempotencyKey: string;
  readonly traceId: string;
}

export interface PersistentEncounterResult {
  readonly encounterId: string;
  readonly status: TerminalStatus;
  readonly outcomeCode?: string;
  readonly providerInvoked: boolean;
  readonly replayed: boolean;
}

/** A run whose reservations are claimed and whose Provider start is recorded. */
interface StartedRun {
  readonly command: PersistentEncounterCommand;
  readonly requestHash: string;
  readonly runKey: string;
  readonly generationTransactionId: string;
  readonly publicationReservationId: string;
  readonly context: AssembledEncounterContext;
}

interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly actualCostMinor: number;
  readonly providerRequestIdHash?: string;
}

export class PersistentEncounterOrchestrator {
  readonly #persistence: EncounterPersistencePort;
  readonly #provider: EncounterProvider;
  readonly #safety: EncounterSafetyPipeline;
  readonly #runtime: EncounterRuntimeConfig;
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(input: {
    persistence: EncounterPersistencePort;
    provider: EncounterProvider;
    safety: EncounterSafetyPipeline;
    runtime: EncounterRuntimeConfig;
    now?: () => string;
    id?: () => string;
  }) {
    this.#persistence = input.persistence;
    this.#provider = input.provider;
    this.#safety = input.safety;
    this.#runtime = input.runtime;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#id = input.id ?? randomUUID;
  }

  async run(command: PersistentEncounterCommand): Promise<PersistentEncounterResult> {
    const { actorOwnerId, invitationId, encounterId } = command;
    const requestHash = hash(command);
    const runKey = hash(`encounter:${actorOwnerId}:${command.idempotencyKey}`);
    const now = this.#now();

    const existing = await this.#persistence.getEncounterTerminal(actorOwnerId, runKey, requestHash);
    if (existing !== undefined) {
      return {
        encounterId: existing.encounterId,
        status: existing.resultStatus,
        ...(existing.outcomeCode === undefined ? {} : { outcomeCode: existing.outcomeCode }),
        providerInvoked: false,
        replayed: true,
      };
    }

    const preparation = await this.#persistence.getEncounterPreparation(actorOwnerId, invitationId);
    const responder = { ownerId: preparation.responderOwnerId, companionId: preparation.responderCompanionId };
    const inputScan = this.#safety.scanInput(command.message);
    const inputSafetyEventId = this.#id();
    await this.#persistence.recordSafetyEvent({
      id: inputSafetyEventId,
      ...responder,
      socialTwinId: preparation.responderTwinId,
      direction: "INPUT",
      decision: inputScan.decision,
      threatTypes: inputScan.threatTypes,
      contentHash: inputScan.contentHash,
      ...(inputScan.decision === "BLOCK" ? {} : { sanitizedContentHash: contentHash(inputScan.sanitized) }),
      redactionCount: inputScan.redactionCount,
      policyVersion: ENCOUNTER_SAFETY_POLICY_VERSION,
      encounterId,
    });
    if (inputScan.decision === "BLOCK") {
      const terminal = await this.#persistence.persistNonDelivery({
        actorOwnerId,
        idempotencyKeyHash: runKey,
        requestHash,
        encounterId,
        invitationId,
        resultStatus: "BLOCKED",
        outcomeCode: "INPUT_SAFETY_BLOCK",
        safetyEventId: inputSafetyEventId,
        occurredAt: now,
      });
      return {
        encounterId,
        status: "BLOCKED",
        outcomeCode: terminal.outcomeCode,
        providerInvoked: false,
        replayed: terminal.replayed,
      };
    }

    // Reserve, claim, assemble context, record START. Until the claim succeeds the reservations are
    // released on any failure; after it, nothing is released and the Provider is never retried.
    let publication: { reservationId: string; decision: string } | undefined;
    let compute: { transactionId: string; decision: string } | undefined;
    let claimed = false;
    try {
      publication = await this.#persistence.reservePublication({
        ...responder,
        relatedEventId: encounterId,
        idempotencyKeyHash: hash(`${runKey}:publication`),
        requestHash: hash({ command: "publication", encounterId }),
      });
      if (publication.decision !== "RESERVED") throw new Error("Publication reservation was not granted.");

      compute = await this.#persistence.reserveCompute({
        ...responder,
        socialTwinId: preparation.responderTwinId,
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
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        identityVersion: preparation.responderIdentityVersion,
        socialPersonaVersion: preparation.responderSocialPersonaVersion,
        memoryPolicyVersion: "memory-permission/1",
        safetyPolicyVersion: ENCOUNTER_SAFETY_POLICY_VERSION,
        routerVersion: this.#runtime.routerVersion,
        traceId: command.traceId,
        attemptNo: 1,
        idempotencyKeyHash: hash(`${runKey}:compute`),
        requestHash: hash({ command: "compute", encounterId }),
      });
      if (compute.decision !== "RESERVED") throw new Error("Compute reservation was not granted.");

      const claim = await this.#persistence.claimEncounter({
        actorOwnerId,
        idempotencyKeyHash: hash(`${runKey}:claim`),
        requestHash: hash({ command: "claim", invitationId, encounterId }),
        encounterId,
        invitationId,
        generationTransactionId: compute.transactionId,
        publicationReservationId: publication.reservationId,
      });
      if (claim.replayed) throw new Error("Encounter execution is already claimed; Provider retry is prohibited.");
      claimed = true;

      const { executionClaimId } = claim;
      const maxMemories = command.maxMemories ?? DEFAULT_MAX_MEMORIES;
      const context = await this.#persistence.assembleEncounterContext({
        actorOwnerId,
        executionClaimId,
        idempotencyKeyHash: hash(`${runKey}:context`),
        requestHash: hash({ executionClaimId, maxMemories }),
        providerRequestHash: hash({
          encounterId,
          executionClaimId,
          generationTransactionId: compute.transactionId,
          inputHash: inputScan.contentHash,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
          traceId: command.traceId,
        }),
        maxMemories,
      });
      await this.#persistence.startCompute(context.responderOwnerId, compute.transactionId);
      return await this.#invokeAndPersist(
        {
          command,
          requestHash,
          runKey,
          generationTransactionId: compute.transactionId,
          publicationReservationId: publication.reservationId,
          context,
        },
        inputScan,
      );
    } catch (error) {
      if (!claimed && compute !== undefined) {
        await this.#persistence
          .releaseCompute(preparation.responderOwnerId, compute.transactionId, PREFLIGHT_FAILED)
          .catch(() => undefined);
      }
      if (!claimed && publication !== undefined) {
        await this.#persistence
          .releasePublication(preparation.responderOwnerId, publication.reservationId, PREFLIGHT_FAILED)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async #invokeAndPersist(run: StartedRun, inputScan: InputScan): Promise<PersistentEncounterResult> {
    const { command, context } = run;
    const runtime = this.#runtime;

    let providerResult;
    try {
      providerResult = await this.#provider.invoke({
        reasonCode: "SOCIAL_ENCOUNTER_RESPONSE",
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        responder: context.responderPersona as EncounterPersonaView,
        untrustedInput: {
          trust: "UNTRUSTED",
          sourceType: "SOCIAL_TWIN",
          sourceTwinId: context.initiatorTwinId,
          content: inputScan.sanitized,
          contentHash: inputScan.contentHash,
        },
        authorizedMemories: context.authorizedMemories,
        maxOutputTokens: runtime.maxOutputTokens,
        traceId: command.traceId,
      });
    } catch {
      // Usage is unknown: charge the whole reserved cost.
      return this.#fail(run, "FAILED", "PROVIDER_ERROR_UNKNOWN_USAGE", {
        inputTokens: runtime.estimatedInputTokens,
        outputTokens: 0,
        actualCostMinor: runtime.reservedCostMinor,
      });
    }

    const within = (value: number, maximum: number): boolean =>
      Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    const valid =
      typeof providerResult.text === "string" &&
      within(providerResult.inputTokens, runtime.estimatedInputTokens) &&
      within(providerResult.outputTokens, runtime.maxOutputTokens) &&
      within(providerResult.actualCostMinor, runtime.reservedCostMinor);
    if (!valid) {
      // Reported usage cannot be trusted: charge every reserved ceiling.
      return this.#fail(run, "FAILED", "PROVIDER_USAGE_CONTRACT_VIOLATION", {
        inputTokens: runtime.estimatedInputTokens,
        outputTokens: runtime.maxOutputTokens,
        actualCostMinor: runtime.reservedCostMinor,
      });
    }

    const usage: Usage = {
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens,
      actualCostMinor: providerResult.actualCostMinor,
      ...(providerResult.providerRequestIdHash === undefined
        ? {}
        : { providerRequestIdHash: providerResult.providerRequestIdHash }),
    };
    const output = this.#safety.scanOutput(providerResult.text);
    const outputSafetyEventId = this.#id();
    const bodyHash = contentHash(output.sanitized);
    await this.#persistence.recordSafetyEvent({
      id: outputSafetyEventId,
      ownerId: context.responderOwnerId,
      companionId: context.responderCompanionId,
      socialTwinId: context.responderTwinId,
      direction: "OUTPUT",
      decision: output.decision,
      threatTypes: output.threatTypes,
      contentHash: output.contentHash,
      ...(output.decision === "BLOCK" ? {} : { sanitizedContentHash: bodyHash }),
      redactionCount: output.redactionCount,
      policyVersion: ENCOUNTER_SAFETY_POLICY_VERSION,
      encounterId: command.encounterId,
    });
    if (output.decision === "BLOCK") {
      return this.#fail(run, "BLOCKED", "OUTPUT_SAFETY_BLOCK", usage, outputSafetyEventId);
    }

    await this.#persistence.settleCompute({
      ownerId: context.responderOwnerId,
      transactionId: run.generationTransactionId,
      ...usage,
      status: "SUCCEEDED",
    });
    const terminal = await this.#persistence.persistDelivery({
      actorOwnerId: command.actorOwnerId,
      idempotencyKeyHash: run.runKey,
      requestHash: run.requestHash,
      encounterId: command.encounterId,
      invitationId: command.invitationId,
      publicationReservationId: run.publicationReservationId,
      body: output.sanitized,
      bodyHash,
      artifactStatus: output.decision === "REDACT" ? "REDACTED" : "DELIVERED",
      generationTransactionId: run.generationTransactionId,
      outputSafetyEventId,
      occurredAt: this.#now(),
    });
    return {
      encounterId: command.encounterId,
      status: terminal.resultStatus,
      providerInvoked: true,
      replayed: terminal.replayed,
    };
  }

  /** Settles what the Provider consumed and records a terminal non-delivery. Nothing is published. */
  async #fail(
    run: StartedRun,
    status: "FAILED" | "BLOCKED",
    outcomeCode: string,
    usage: Usage,
    safetyEventId?: string,
  ): Promise<PersistentEncounterResult> {
    const { command, context } = run;
    await this.#persistence.settleCompute({
      ownerId: context.responderOwnerId,
      transactionId: run.generationTransactionId,
      ...usage,
      status,
      outcomeCode,
    });
    const terminal = await this.#persistence.persistNonDelivery({
      actorOwnerId: command.actorOwnerId,
      idempotencyKeyHash: run.runKey,
      requestHash: run.requestHash,
      encounterId: command.encounterId,
      invitationId: command.invitationId,
      resultStatus: status,
      outcomeCode,
      generationTransactionId: run.generationTransactionId,
      publicationReservationId: run.publicationReservationId,
      ...(safetyEventId === undefined ? {} : { safetyEventId }),
      occurredAt: this.#now(),
    });
    return {
      encounterId: command.encounterId,
      status,
      outcomeCode: terminal.outcomeCode,
      providerInvoked: true,
      replayed: terminal.replayed,
    };
  }
}

export const createProductionEncounterOrchestrator = (input: {
  persistence: PostgresServerAdapter;
  provider: EncounterProvider;
  safety: EncounterSafetyPipeline;
  runtime: EncounterRuntimeConfig;
  now?: () => string;
  id?: () => string;
}): PersistentEncounterOrchestrator => new PersistentEncounterOrchestrator(input);
