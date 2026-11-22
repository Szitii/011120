import type { CompanionIdentity, ImportReview } from "../../companion-import/types.ts";
import type { ComputeReceipt } from "../../compute/receipt.ts";
import type { BillingParty, ReasonCode } from "../../compute/types.ts";
import type {
  ActiveIdentityContextView,
  CompanionProfileView,
  ControlsResourceView,
  EncounterDetailView,
  LifeContinuityCollectionView,
  LifeContinuityItemView,
  LifeEventInboxCollectionView,
  LifeEventInboxItemView,
  OwnerApiPort,
  OwnerCompanionSummaryView,
  ProjectionResultView,
  WorldCollectionView,
  WorldItemView,
} from "../../http/types.ts";
import {
  PostgresPersistenceError,
  persistenceError,
  type AssembleEncounterContextInput,
  type AssembledEncounterContext,
  type ClaimEncounterInput,
  type ClaimEncounterResult,
  type EncounterPreparation,
  type EncounterTerminalResult,
  type InvitationListCursor,
  type InvitationMutationResult,
  type IssueInvitationInput,
  type LedgerMutationResult,
  type OwnerInvitation,
  type PersistDeliveryInput,
  type PersistDeliveryResult,
  type PersistNonDeliveryInput,
  type PersistNonDeliveryResult,
  type ReconcileStartedInput,
  type ReconcileStartedResult,
  type RecordSafetyEventInput,
  type ReserveComputeInput,
  type ReserveComputeResult,
  type ReservePublicationInput,
  type ReservePublicationResult,
  type SettleComputeInput,
  type SqlExecutor,
  type StaleStartedCandidate,
  type StaleStartedCursor,
} from "./types.ts";

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const INVITATION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;
const SOURCE_TRUSTS = ["OWNER_ASSERTED", "PLATFORM_EVENT", "MODEL_DERIVED", "EXTERNAL_UNTRUSTED"] as const;

// Scalar columns of command results are validated; a mismatch is a DATABASE_ERROR, never a guess.
// JSON payloads assembled by the database read functions are only checked to be objects.
const invalid = (name: string): never => {
  throw new PostgresPersistenceError("DATABASE_ERROR", `Invalid ${name} returned by PostgreSQL.`);
};
const text = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : invalid(key);
};
const uuid = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" && UUID.test(value) ? value : invalid(key);
};
const bool = (row: Row, key: string): boolean => {
  const value = row[key];
  return typeof value === "boolean" ? value : invalid(key);
};
const integer = (row: Row, key: string): number => {
  const value = typeof row[key] === "string" ? Number(row[key]) : row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : invalid(key);
};
const timestamp = (row: Row, key: string): string => {
  const value = row[key];
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return date === undefined || Number.isNaN(date.valueOf()) ? invalid(key) : date.toISOString();
};
const oneOf = <T extends string>(row: Row, key: string, allowed: readonly T[]): T => {
  const value = row[key] as T;
  return allowed.includes(value) ? value : invalid(key);
};
const strings = (row: Row, key: string): readonly string[] => {
  const value = row[key] ?? [];
  const valid = Array.isArray(value) && value.every((item) => typeof item === "string");
  return valid ? Object.freeze([...(value as string[])]) : invalid(key);
};
const record = (value: unknown, name: string): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : invalid(name);
const json = <T>(row: Row, key: "payload" | "item"): T => record(row[key], key) as unknown as T;
const absent = (row: Row, key: string): boolean => row[key] === null || row[key] === undefined;

// The only place that touches the executor: one fixed, parameterized statement per call.
async function rows(executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<readonly Row[]> {
  try {
    return (await executor.query<Row>(sql, values)).rows;
  } catch (error) {
    throw persistenceError(error);
  }
}
const first = async (executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row | undefined> =>
  (await rows(executor, sql, values))[0];
async function one(executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row> {
  const result = await rows(executor, sql, values);
  if (result.length !== 1) {
    throw new PostgresPersistenceError("DATABASE_ERROR", "PostgreSQL command returned an unexpected row count.");
  }
  return result[0]!;
}

const ledger = (r: Row): LedgerMutationResult => ({
  ledgerEntryId: uuid(r, "ledger_entry_id"),
  ledgerSequence: integer(r, "ledger_sequence"),
  decision: text(r, "decision"),
  replayed: bool(r, "replayed"),
});
const reservation = (r: Row) => ({
  budgetId: uuid(r, "budget_id"),
  decision: text(r, "decision"),
  ...(absent(r, "outcome_code") ? {} : { outcomeCode: text(r, "outcome_code") }),
  replayed: bool(r, "replayed"),
});
const encounterParties = (r: Row) => ({
  initiatorTwinId: uuid(r, "initiator_twin_id"),
  responderOwnerId: uuid(r, "responder_owner_id"),
  responderCompanionId: uuid(r, "responder_companion_id"),
  responderTwinId: uuid(r, "responder_twin_id"),
  responderSocialPersonaVersion: integer(r, "responder_social_persona_version"),
  responderIdentityVersion: integer(r, "responder_identity_version"),
});
const invitationMutation = (r: Row, occurredAt: "created_at" | "decided_at"): InvitationMutationResult => ({
  invitationId: uuid(r, "invitation_id"),
  status: oneOf(r, "status", INVITATION_STATUSES),
  occurredAt: timestamp(r, occurredAt),
  replayed: bool(r, "replayed"),
});
const page = <T, C>(items: readonly T[], limit: number, cursor: (last: T) => C) => {
  const last = items.at(-1);
  const nextCursor = items.length === limit && last !== undefined ? cursor(last) : null;
  return { items: Object.freeze(items), nextCursor };
};

export class PostgresServerAdapter {
  readonly #executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.#executor = executor;
  }

  async getEncounterTerminal(
    actorOwnerId: string,
    idempotencyKeyHash: string,
    requestHash: string,
  ): Promise<EncounterTerminalResult | undefined> {
    const r = await first(this.#executor, "select * from companion_private.get_encounter_terminal_result($1,$2,$3)", [
      actorOwnerId, idempotencyKeyHash, requestHash,
    ]);
    if (r === undefined) return undefined;
    return {
      encounterId: uuid(r, "encounter_id"),
      resultStatus: oneOf(r, "result_status", ["BLOCKED", "FAILED", "DELIVERED", "REDACTED"]),
      ...(absent(r, "outcome_code") ? {} : { outcomeCode: text(r, "outcome_code") }),
    };
  }

  async getEncounterPreparation(actorOwnerId: string, invitationId: string): Promise<EncounterPreparation> {
    const r = await one(this.#executor, "select * from companion_private.get_encounter_preparation($1,$2)", [
      actorOwnerId, invitationId,
    ]);
    return { initiatorOwnerId: uuid(r, "initiator_owner_id"), ...encounterParties(r) };
  }

  async assembleEncounterContext(input: AssembleEncounterContextInput): Promise<AssembledEncounterContext> {
    const r = await one(
      this.#executor,
      "select * from companion_private.assemble_encounter_context($1,$2,$3,$4,$5,$6)",
      [
        input.actorOwnerId, input.executionClaimId, input.idempotencyKeyHash, input.requestHash,
        input.providerRequestHash, input.maxMemories,
      ],
    );
    const persona = record(r.responder_persona, "responder_persona");
    const document = record(persona.publicDocument, "publicDocument");
    const memories = Array.isArray(r.authorized_memories) ? r.authorized_memories : invalid("authorized_memories");
    return {
      snapshotId: uuid(r, "snapshot_id"),
      encounterId: uuid(r, "encounter_id"),
      generationTransactionId: uuid(r, "generation_transaction_id"),
      ...encounterParties(r),
      responderPersona: {
        socialTwinId: uuid(persona, "socialTwinId"),
        socialPersonaId: uuid(persona, "socialPersonaId"),
        socialPersonaVersion: integer(persona, "socialPersonaVersion"),
        handle: text(persona, "handle"),
        displayName: text(persona, "displayName"),
        publicTraits: strings(document, "publicTraits"),
        publicVoice: record(document.publicVoice ?? {}, "publicVoice") as Readonly<Record<string, string>>,
        publicInterests: strings(document, "publicInterests"),
        publicBoundaries: strings(document, "publicBoundaries"),
      },
      authorizedMemories: Object.freeze(memories.map((value: unknown) => {
        const memory = record(value, "authorized memory");
        return {
          id: uuid(memory, "id"),
          representation: text(memory, "representation"),
          disclosure: oneOf(memory, "disclosure", ["PRESENCE_ONLY", "SUMMARY"]),
          sourceTrust: oneOf(memory, "sourceTrust", SOURCE_TRUSTS),
        };
      })),
      manifest: Object.freeze(record(r.manifest, "manifest")),
      manifestHash: text(r, "manifest_hash"),
      replayed: bool(r, "replayed"),
    };
  }

  async reserveCompute(input: ReserveComputeInput): Promise<ReserveComputeResult> {
    const r = await one(
      this.#executor,
      "select * from companion_private.reserve_compute_transaction(" +
        "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)",
      [
        input.ownerId, input.companionId, input.socialTwinId ?? null,
        input.reasonCode, input.triggerEventType, input.triggerEventId,
        input.providerId, input.credentialId ?? null, input.canonicalModel, input.providerModel,
        input.billingParty, input.currency, input.pricingVersion,
        input.estimatedInputTokens, input.maxOutputTokens, input.reservedCostMinor,
        input.promptTemplateVersion, input.identityVersion, input.socialPersonaVersion ?? null,
        input.memoryPolicyVersion, input.safetyPolicyVersion, input.routerVersion,
        input.traceId, input.attemptNo, input.retryParentTransactionId ?? null,
        input.idempotencyKeyHash, input.requestHash,
      ],
    );
    return { transactionId: uuid(r, "transaction_id"), ...reservation(r) };
  }

  async reservePublication(input: ReservePublicationInput): Promise<ReservePublicationResult> {
    const r = await one(this.#executor, "select * from companion_private.reserve_publication($1,$2,$3,$4,$5)", [
      input.ownerId, input.companionId, input.relatedEventId, input.idempotencyKeyHash, input.requestHash,
    ]);
    return { reservationId: uuid(r, "reservation_id"), ...reservation(r) };
  }

  async claimEncounter(input: ClaimEncounterInput): Promise<ClaimEncounterResult> {
    const r = await one(
      this.#executor,
      "select * from companion_private.claim_encounter_execution($1,$2,$3,$4,$5,$6,$7)",
      [
        input.actorOwnerId, input.idempotencyKeyHash, input.requestHash, input.encounterId, input.invitationId,
        input.generationTransactionId, input.publicationReservationId,
      ],
    );
    return {
      executionClaimId: uuid(r, "execution_claim_id"),
      encounterId: uuid(r, "encounter_id"),
      invitationId: uuid(r, "invitation_id"),
      claimedAt: timestamp(r, "claimed_at"),
      replayed: bool(r, "replayed"),
    };
  }

  async startCompute(ownerId: string, transactionId: string): Promise<LedgerMutationResult> {
    return ledger(await one(this.#executor, "select * from companion_private.start_compute_transaction($1,$2)", [
      ownerId, transactionId,
    ]));
  }

  async releaseCompute(ownerId: string, transactionId: string, outcomeCode: string): Promise<LedgerMutationResult> {
    return ledger(await one(this.#executor, "select * from companion_private.release_compute_transaction($1,$2,$3)", [
      ownerId, transactionId, outcomeCode,
    ]));
  }

  async releasePublication(ownerId: string, reservationId: string, outcomeCode: string): Promise<void> {
    await one(
      this.#executor,
      "select * from companion_private.complete_publication_reservation($1,$2,'RELEASED',$3)",
      [ownerId, reservationId, outcomeCode],
    );
  }

  async recordSafetyEvent(input: RecordSafetyEventInput): Promise<string> {
    const r = await one(
      this.#executor,
      "select * from companion_private.record_encounter_safety_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        input.id, input.ownerId, input.companionId, input.socialTwinId, input.direction, input.decision,
        [...input.threatTypes], input.contentHash, input.sanitizedContentHash ?? null, input.redactionCount,
        input.policyVersion, input.encounterId,
      ],
    );
    return uuid(r, "safety_event_id");
  }

  async settleCompute(input: SettleComputeInput): Promise<LedgerMutationResult> {
    return ledger(await one(
      this.#executor,
      "select * from companion_private.settle_compute_transaction($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        input.ownerId, input.transactionId, input.inputTokens, input.outputTokens, input.actualCostMinor,
        input.status, input.outcomeCode ?? null, input.providerRequestIdHash ?? null,
      ],
    ));
  }

  async persistNonDelivery(input: PersistNonDeliveryInput): Promise<PersistNonDeliveryResult> {
    const r = await one(
      this.#executor,
      "select * from companion_private.persist_encounter_non_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        input.actorOwnerId, input.idempotencyKeyHash, input.requestHash, input.encounterId, input.invitationId,
        input.resultStatus, input.outcomeCode, input.generationTransactionId ?? null,
        input.publicationReservationId ?? null, input.safetyEventId ?? null, input.occurredAt,
      ],
    );
    return {
      encounterId: uuid(r, "encounter_id"),
      resultStatus: oneOf(r, "result_status", ["BLOCKED", "FAILED"]),
      outcomeCode: text(r, "outcome_code"),
      invitationConsumed: bool(r, "invitation_consumed"),
      publicationReleased: bool(r, "publication_released"),
      replayed: bool(r, "replayed"),
    };
  }

  async persistDelivery(input: PersistDeliveryInput): Promise<PersistDeliveryResult> {
    const r = await one(
      this.#executor,
      "select * from companion_private.persist_delivered_encounter($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        input.actorOwnerId, input.idempotencyKeyHash, input.requestHash, input.encounterId, input.invitationId,
        input.publicationReservationId, input.body, input.bodyHash, input.artifactStatus,
        input.generationTransactionId, input.outputSafetyEventId, input.occurredAt,
      ],
    );
    return {
      encounterId: uuid(r, "encounter_id"),
      artifactId: uuid(r, "artifact_id"),
      initiatorLifeEventId: uuid(r, "initiator_life_event_id"),
      responderLifeEventId: uuid(r, "responder_life_event_id"),
      resultStatus: oneOf(r, "result_status", ["DELIVERED", "REDACTED"]),
      replayed: bool(r, "replayed"),
    };
  }

  async listStaleStarted(
    cutoff: string,
    limit: number,
    after?: StaleStartedCursor,
  ): Promise<readonly StaleStartedCandidate[]> {
    const result = await rows(
      this.#executor,
      "select * from companion_private.list_stale_started_encounter_candidates($1,$2,$3,$4)",
      [cutoff, after?.staleAt ?? null, after?.executionClaimId ?? null, limit],
    );
    return result.map((r) => ({
      executionClaimId: uuid(r, "execution_claim_id"),
      actorOwnerId: uuid(r, "actor_owner_id"),
      encounterId: uuid(r, "encounter_id"),
      startedAt: timestamp(r, "started_at"),
      staleAt: timestamp(r, "stale_at"),
    }));
  }

  async reconcileStarted(input: ReconcileStartedInput): Promise<ReconcileStartedResult> {
    const r = await one(
      this.#executor,
      "select * from companion_private.reconcile_stale_started_encounter($1,$2,$3,$4,$5)",
      [
        input.actorOwnerId, input.executionClaimId, input.reasonCode, input.evidenceSource,
        input.providerRequestIdHash ?? null,
      ],
    );
    return {
      encounterId: uuid(r, "encounter_id"),
      ledgerEntryId: uuid(r, "ledger_entry_id"),
      resultStatus: oneOf(r, "result_status", ["FAILED"]),
      outcomeCode: text(r, "outcome_code"),
      conservativeCostMinor: integer(r, "conservative_cost_minor"),
      invitationConsumed: bool(r, "invitation_consumed"),
      publicationReleased: bool(r, "publication_released"),
      replayed: bool(r, "replayed"),
    };
  }
}

export class PostgresOwnerAdapter implements OwnerApiPort {
  readonly #executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.#executor = executor;
  }

  async getComputeReceipt(transactionId: string): Promise<ComputeReceipt | undefined> {
    const r = await first(this.#executor, "select * from public.get_compute_receipt($1)", [transactionId]);
    if (r === undefined) return undefined;
    return {
      transactionId: uuid(r, "transaction_id"),
      ownerId: uuid(r, "owner_id"),
      companionId: uuid(r, "companion_id"),
      ...(absent(r, "social_twin_id") ? {} : { socialTwinId: text(r, "social_twin_id") }),
      reasonCode: text(r, "reason_code") as ReasonCode,
      triggerEventType: text(r, "trigger_event_type"),
      triggerEventId: uuid(r, "trigger_event_id"),
      providerId: text(r, "provider_id"),
      canonicalModel: text(r, "canonical_model"),
      providerModel: text(r, "provider_model"),
      billingParty: text(r, "billing_party") as BillingParty,
      currency: text(r, "currency"),
      inputTokens: integer(r, "input_tokens"),
      outputTokens: integer(r, "output_tokens"),
      reservedCostMinor: integer(r, "reserved_cost_minor"),
      actualCostMinor: integer(r, "actual_cost_minor"),
      outcome: text(r, "outcome"),
      promptTemplateVersion: text(r, "prompt_template_version"),
      identityVersion: integer(r, "identity_version"),
      ...(absent(r, "social_persona_version")
        ? {}
        : { socialPersonaVersion: integer(r, "social_persona_version") }),
      memoryPolicyVersion: text(r, "memory_policy_version"),
      safetyPolicyVersion: text(r, "safety_policy_version"),
      routerVersion: text(r, "router_version"),
      attemptNo: integer(r, "attempt_no"),
    };
  }

  async issueInvitation(input: IssueInvitationInput): Promise<InvitationMutationResult> {
    const r = await one(
      this.#executor,
      "select * from public.issue_encounter_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        input.initiatorTwinId, input.responderTwinId, input.initiatorSocialPersonaId, input.responderSocialPersonaId,
        input.initiatorIdentityVersionId, input.responderIdentityVersionId, input.purpose, input.scope,
        input.contextHash, input.expiresAt, input.idempotencyKeyHash, input.requestHash,
      ],
    );
    return invitationMutation(r, "created_at");
  }

  async approveInvitation(
    invitationId: string,
    idempotencyKeyHash: string,
    requestHash: string,
  ): Promise<InvitationMutationResult> {
    const r = await one(this.#executor, "select * from public.approve_encounter_invitation($1,$2,$3)", [
      invitationId, idempotencyKeyHash, requestHash,
    ]);
    return invitationMutation(r, "decided_at");
  }

  async rejectInvitation(
    invitationId: string,
    idempotencyKeyHash: string,
    requestHash: string,
  ): Promise<InvitationMutationResult> {
    const r = await one(this.#executor, "select * from public.reject_encounter_invitation($1,$2,$3)", [
      invitationId, idempotencyKeyHash, requestHash,
    ]);
    return invitationMutation(r, "decided_at");
  }

  async listInvitations(limit: number, before?: InvitationListCursor): Promise<readonly OwnerInvitation[]> {
    const result = await rows(this.#executor, "select * from public.list_encounter_invitations($1,$2,$3)", [
      limit, before?.createdAt ?? null, before?.invitationId ?? null,
    ]);
    return result.map((r) => ({
      invitationId: uuid(r, "invitation_id"),
      status: oneOf(r, "status", INVITATION_STATUSES),
      role: oneOf(r, "role", ["INITIATOR", "RESPONDER"]),
      initiatorOwnerId: uuid(r, "initiator_owner_id"),
      initiatorTwinId: uuid(r, "initiator_twin_id"),
      responderOwnerId: uuid(r, "responder_owner_id"),
      responderTwinId: uuid(r, "responder_twin_id"),
      purpose: text(r, "purpose"),
      scope: oneOf(r, "scope", ["ONE_SHOT_ENCOUNTER"]),
      contextHash: text(r, "context_hash"),
      expiresAt: timestamp(r, "expires_at"),
      ...(absent(r, "claimed_at") ? {} : { claimedAt: timestamp(r, "claimed_at") }),
      ...(absent(r, "used_at") ? {} : { usedAt: timestamp(r, "used_at") }),
      createdAt: timestamp(r, "created_at"),
    }));
  }

  async getIdentityContext(
    input?: Parameters<OwnerApiPort["getIdentityContext"]>[0],
  ): Promise<ActiveIdentityContextView> {
    const r = await one(this.#executor, "select * from public.get_active_identity_context($1,$2)", [
      input?.activeSubjectKind ?? "OWNER", input?.activeSubjectId ?? null,
    ]);
    return json<ActiveIdentityContextView>(r, "payload");
  }

  async listOwnerCompanions(): Promise<readonly OwnerCompanionSummaryView[]> {
    const result = await rows(this.#executor, "select * from public.list_owner_companions()", []);
    return Object.freeze(result.map((r) => json<OwnerCompanionSummaryView>(r, "item")));
  }

  async listWorldItems(limit: number, beforeCreatedAt?: string): Promise<WorldCollectionView> {
    const result = await rows(this.#executor, "select * from public.list_world_items($1,$2)", [
      limit, beforeCreatedAt ?? null,
    ]);
    return page(result.map((r) => json<WorldItemView>(r, "item")), limit, (last) => last.publishedAt);
  }

  async listLifeContinuity(
    limit: number,
    viewer?: Parameters<OwnerApiPort["listLifeContinuity"]>[1],
    before?: Parameters<OwnerApiPort["listLifeContinuity"]>[2],
  ): Promise<LifeContinuityCollectionView> {
    const result = await rows(this.#executor, "select * from public.list_life_continuity($1,$2,$3,$4,$5)", [
      viewer?.activeSubjectKind ?? "OWNER", viewer?.activeSubjectId ?? null, limit,
      before?.occurredAt ?? null, before?.id ?? null,
    ]);
    return page(result.map((r) => json<LifeContinuityItemView>(r, "item")), limit, (last) => ({
      beforeOccurredAt: last.occurredAt,
      beforeId: last.id,
    }));
  }

  async getCompanionProfile(
    companionId: string,
    viewer?: Parameters<OwnerApiPort["getCompanionProfile"]>[1],
  ): Promise<CompanionProfileView | undefined> {
    const r = await first(this.#executor, "select * from public.get_companion_profile($1,$2,$3)", [
      companionId, viewer?.activeSubjectKind ?? "OWNER", viewer?.activeSubjectId ?? null,
    ]);
    return r && json<CompanionProfileView>(r, "payload");
  }

  async getEncounterDetail(encounterId: string): Promise<EncounterDetailView | undefined> {
    const r = await first(this.#executor, "select * from public.get_encounter_detail($1)", [encounterId]);
    return r && json<EncounterDetailView>(r, "payload");
  }

  async listLifeEventInbox(
    limit: number,
    before?: Parameters<OwnerApiPort["listLifeEventInbox"]>[1],
  ): Promise<LifeEventInboxCollectionView> {
    const result = await rows(this.#executor, "select * from public.list_life_event_inbox($1,$2,$3)", [
      limit, before?.createdAt ?? null, before?.id ?? null,
    ]);
    return page(result.map((r) => json<LifeEventInboxItemView>(r, "item")), limit, (last) => ({
      beforeCreatedAt: last.createdAt,
      beforeId: last.id,
    }));
  }

  async acknowledgeLifeEvent(itemId: string): Promise<LifeEventInboxItemView | undefined> {
    const r = await first(this.#executor, "select * from public.ack_life_event_inbox_item($1)", [itemId]);
    return r && json<LifeEventInboxItemView>(r, "item");
  }

  async getControls(companionId: string): Promise<ControlsResourceView | undefined> {
    const r = await first(this.#executor, "select * from public.get_companion_controls($1)", [companionId]);
    return r && json<ControlsResourceView>(r, "payload");
  }

  async updateControls(
    input: Parameters<OwnerApiPort["updateControls"]>[0],
  ): Promise<ControlsResourceView | undefined> {
    const r = await first(this.#executor, "select * from public.update_companion_controls($1,$2,$3,$4,$5)", [
      input.companionId, input.ifMatch, input.patch, input.idempotencyKeyHash, input.requestHash,
    ]);
    return r && json<ControlsResourceView>(r, "payload");
  }

  async createCompanionImport(input: Parameters<OwnerApiPort["createCompanionImport"]>[0]): Promise<ImportReview> {
    const r = await one(
      this.#executor,
      "select * from public.create_companion_import($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)",
      [
        input.rawPayload, input.originalSha256, input.byteLength, input.parserVersion, input.policyVersion,
        input.sourceFormat, JSON.stringify(input.draft), JSON.stringify(input.findings),
        input.idempotencyKeyHash, input.requestHash,
      ],
    );
    return json<ImportReview>(r, "payload");
  }

  async getCompanionImportReview(importId: string): Promise<ImportReview | undefined> {
    const r = await first(this.#executor, "select * from public.get_companion_import_review($1)", [importId]);
    return r && json<ImportReview>(r, "payload");
  }

  async projectAndActivateSocialTwin(
    input: Parameters<OwnerApiPort["projectAndActivateSocialTwin"]>[0],
  ): Promise<ProjectionResultView> {
    const r = await one(
      this.#executor,
      "select * from public.project_and_activate_social_twin($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
      [
        input.companionId, input.sourceIdentityVersionId, input.handle, input.profileVisibility, input.autonomyMode,
        JSON.stringify(input.selections), input.idempotencyKeyHash, input.requestHash,
      ],
    );
    return json<ProjectionResultView>(r, "payload");
  }

  async approveCompanionImport(
    input: Parameters<OwnerApiPort["approveCompanionImport"]>[0],
  ): Promise<CompanionIdentity> {
    const r = await one(this.#executor, "select * from public.approve_companion_import($1,$2,$3,$4,$5)", [
      input.importId, [...input.approvedCandidateIds], input.companionId ?? null,
      input.idempotencyKeyHash, input.requestHash,
    ]);
    return json<CompanionIdentity>(r, "payload");
  }
}
