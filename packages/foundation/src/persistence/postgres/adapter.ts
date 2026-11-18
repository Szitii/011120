import type { ImportReview, CompanionIdentity, NormalizedIdentityDraft, ImportFinding, CompanionImportRecord } from "../../companion-import/types.ts";
import type { ComputeReceipt } from "../../compute/receipt.ts";
import type { BillingParty, ReasonCode } from "../../compute/types.ts";
import { PostgresPersistenceError, type ActiveIdentityContextView, type WorldCollectionView, type LifeContinuityCollectionView, type LifeContinuityItemView, type CompanionProfileView, type EncounterDetailView, type LifeEventInboxCollectionView, type LifeEventInboxItemView, type ControlsResourceView, type ControlsPatchInput, type AssembleEncounterContextInput, type AssembledEncounterContext, type ClaimEncounterInput, type ClaimEncounterResult, type EncounterPreparation, type EncounterTerminalResult, type InvitationListCursor, type InvitationMutationResult, type InvitationStatus, type IssueInvitationInput, type LedgerMutationResult, type OwnerInvitation, type PersistDeliveryInput, type PersistDeliveryResult, type PersistNonDeliveryInput, type PersistNonDeliveryResult, type ReconcileStartedInput, type ReconcileStartedResult, type RecordSafetyEventInput, type ReserveComputeInput, type ReserveComputeResult, type ReservePublicationInput, type ReservePublicationResult, type SettleComputeInput, type SqlExecutor, type StaleStartedCandidate, type StaleStartedCursor, type StartComputeResult } from "./types.ts";

type Row = Record<string, unknown>;
const uuid = (v: unknown, n: string) => { if (typeof v !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)) throw new PostgresPersistenceError("DATABASE_ERROR", `Invalid ${n} returned by PostgreSQL.`); return v; };
const text = (v: unknown, n: string) => { if (typeof v !== "string") throw new PostgresPersistenceError("DATABASE_ERROR", `Invalid ${n} returned by PostgreSQL.`); return v; };
const timestamp = (v: unknown, n: string) => { if (v instanceof Date && !Number.isNaN(v.valueOf())) return v.toISOString(); if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString(); throw new PostgresPersistenceError("DATABASE_ERROR", `Invalid ${n} returned by PostgreSQL.`); };
const bool = (v: unknown, n: string) => { if (typeof v !== "boolean") throw new PostgresPersistenceError("DATABASE_ERROR", `Invalid ${n} returned by PostgreSQL.`); return v; };
const integer = (v: unknown, n: string) => { const x = typeof v === "string" ? Number(v) : v; if (typeof x !== "number" || !Number.isSafeInteger(x)) throw new PostgresPersistenceError("DATABASE_ERROR", `Invalid ${n} returned by PostgreSQL.`); return x; };
const optionalText = (v: unknown) => v === null || v === undefined ? undefined : text(v, "nullable text");
const optionalTimestamp = (v: unknown, n:string) => v === null || v === undefined ? undefined : timestamp(v,n);
const invitationStatus=(v:unknown):InvitationStatus=>{const value=text(v,"invitation status");if(!["PENDING","APPROVED","REJECTED","EXPIRED"].includes(value))throw new PostgresPersistenceError("DATABASE_ERROR","Invalid invitation status returned by PostgreSQL.");return value as InvitationStatus;};
const invitationScope=(v:unknown):"ONE_SHOT_ENCOUNTER"=>{if(v!=="ONE_SHOT_ENCOUNTER")throw new PostgresPersistenceError("DATABASE_ERROR","Invalid invitation scope returned by PostgreSQL.");return v;};
const object=(v:unknown,n:string):Record<string,unknown>=>{if(v===null||typeof v!=="object"||Array.isArray(v))throw new PostgresPersistenceError("DATABASE_ERROR",`Invalid ${n} returned by PostgreSQL.`);return v as Record<string,unknown>;};
const stringArray=(v:unknown,n:string):readonly string[]=>{if(!Array.isArray(v)||!v.every(x=>typeof x==="string"))throw new PostgresPersistenceError("DATABASE_ERROR",`Invalid ${n} returned by PostgreSQL.`);return Object.freeze([...v]);};

function translate(error: unknown): never {
  const e = error as { code?: unknown; message?: unknown };
  const state = typeof e.code === "string" ? e.code : undefined;
  const code = state === "P0001" ? "NOT_FOUND" : state === "22023" ? "INVALID_INPUT" : state === "23505" ? "CONFLICT" : state === "42501" ? "FORBIDDEN" : state === "55000" ? "INVALID_STATE" : state?.startsWith("08") ? "DATABASE_UNAVAILABLE" : "DATABASE_ERROR";
  throw new PostgresPersistenceError(code, typeof e.message === "string" ? e.message : "PostgreSQL command failed.", state);
}

async function one(executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row> {
  try { const result = await executor.query<Row>(sql, values); if (result.rows.length !== 1) throw new PostgresPersistenceError("DATABASE_ERROR", "PostgreSQL command returned an unexpected row count."); return result.rows[0]!; } catch (error) { if (error instanceof PostgresPersistenceError) throw error; return translate(error); }
}

export class PostgresServerAdapter {
  readonly #executor: SqlExecutor;
  constructor(executor: SqlExecutor) { this.#executor = executor; }
  async getEncounterTerminal(actorOwnerId:string,idempotencyKeyHash:string,requestHash:string):Promise<EncounterTerminalResult|undefined>{try{const result=await this.#executor.query<Row>("select * from companion_private.get_encounter_terminal_result($1,$2,$3)",[actorOwnerId,idempotencyKeyHash,requestHash]);if(result.rows.length===0)return undefined;const r=result.rows[0]!,status=text(r.result_status,"result_status");if(!["BLOCKED","FAILED","DELIVERED","REDACTED"].includes(status))throw new PostgresPersistenceError("DATABASE_ERROR","Invalid Encounter terminal status returned by PostgreSQL.");const outcomeCode=optionalText(r.outcome_code);return {encounterId:uuid(r.encounter_id,"encounter_id"),resultStatus:status as EncounterTerminalResult["resultStatus"],...(outcomeCode===undefined?{}:{outcomeCode})};}catch(error){return translate(error);}}
  async getEncounterPreparation(actorOwnerId:string,invitationId:string):Promise<EncounterPreparation>{const r=await one(this.#executor,"select * from companion_private.get_encounter_preparation($1,$2)",[actorOwnerId,invitationId]);return {initiatorOwnerId:uuid(r.initiator_owner_id,"initiator_owner_id"),initiatorTwinId:uuid(r.initiator_twin_id,"initiator_twin_id"),responderOwnerId:uuid(r.responder_owner_id,"responder_owner_id"),responderCompanionId:uuid(r.responder_companion_id,"responder_companion_id"),responderTwinId:uuid(r.responder_twin_id,"responder_twin_id"),responderSocialPersonaVersion:integer(r.responder_social_persona_version,"responder_social_persona_version"),responderIdentityVersion:integer(r.responder_identity_version,"responder_identity_version")};}
  async assembleEncounterContext(input:AssembleEncounterContextInput):Promise<AssembledEncounterContext>{const r=await one(this.#executor,"select * from companion_private.assemble_encounter_context($1,$2,$3,$4,$5,$6)",[input.actorOwnerId,input.executionClaimId,input.idempotencyKeyHash,input.requestHash,input.providerRequestHash,input.maxMemories]);const p=object(r.responder_persona,"responder_persona"),doc=object(p.publicDocument,"publicDocument"),rawMemories=r.authorized_memories;if(!Array.isArray(rawMemories))throw new PostgresPersistenceError("DATABASE_ERROR","Invalid authorized memories returned by PostgreSQL.");const memories=rawMemories.map((value)=>{const m=object(value,"authorized memory"),rawDisclosure=text(m.disclosure,"memory disclosure"),sourceTrust=text(m.sourceTrust,"memory source trust");if(rawDisclosure!=="PRESENCE_ONLY"&&rawDisclosure!=="SUMMARY")throw new PostgresPersistenceError("DATABASE_ERROR","Invalid memory disclosure returned by PostgreSQL.");if(!["OWNER_ASSERTED","PLATFORM_EVENT","MODEL_DERIVED","EXTERNAL_UNTRUSTED"].includes(sourceTrust))throw new PostgresPersistenceError("DATABASE_ERROR","Invalid memory source trust returned by PostgreSQL.");const disclosure:AssembledEncounterContext["authorizedMemories"][number]["disclosure"]=rawDisclosure;return {id:uuid(m.id,"memory id"),representation:text(m.representation,"memory representation"),disclosure,sourceTrust:sourceTrust as AssembledEncounterContext["authorizedMemories"][number]["sourceTrust"]};});return {snapshotId:uuid(r.snapshot_id,"snapshot_id"),encounterId:uuid(r.encounter_id,"encounter_id"),generationTransactionId:uuid(r.generation_transaction_id,"generation_transaction_id"),initiatorTwinId:uuid(r.initiator_twin_id,"initiator_twin_id"),responderOwnerId:uuid(r.responder_owner_id,"responder_owner_id"),responderCompanionId:uuid(r.responder_companion_id,"responder_companion_id"),responderTwinId:uuid(r.responder_twin_id,"responder_twin_id"),responderSocialPersonaVersion:integer(r.responder_social_persona_version,"responder_social_persona_version"),responderIdentityVersion:integer(r.responder_identity_version,"responder_identity_version"),responderPersona:{socialTwinId:uuid(p.socialTwinId,"persona socialTwinId"),socialPersonaId:uuid(p.socialPersonaId,"persona socialPersonaId"),socialPersonaVersion:integer(p.socialPersonaVersion,"persona version"),handle:text(p.handle,"persona handle"),displayName:text(p.displayName,"persona displayName"),publicTraits:stringArray(doc.publicTraits??[],"publicTraits"),publicVoice:object(doc.publicVoice??{},"publicVoice") as Readonly<Record<string,string>>,publicInterests:stringArray(doc.publicInterests??[],"publicInterests"),publicBoundaries:stringArray(doc.publicBoundaries??[],"publicBoundaries")},authorizedMemories:Object.freeze(memories),manifest:Object.freeze(object(r.manifest,"manifest")),manifestHash:text(r.manifest_hash,"manifest_hash"),replayed:bool(r.replayed,"replayed")};}
  async reserveCompute(input: ReserveComputeInput): Promise<ReserveComputeResult> {
    const r = await one(this.#executor, "select * from companion_private.reserve_compute_transaction($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)", [input.ownerId,input.companionId,input.socialTwinId??null,input.reasonCode,input.triggerEventType,input.triggerEventId,input.providerId,input.credentialId??null,input.canonicalModel,input.providerModel,input.billingParty,input.currency,input.pricingVersion,input.estimatedInputTokens,input.maxOutputTokens,input.reservedCostMinor,input.promptTemplateVersion,input.identityVersion,input.socialPersonaVersion??null,input.memoryPolicyVersion,input.safetyPolicyVersion,input.routerVersion,input.traceId,input.attemptNo,input.retryParentTransactionId??null,input.idempotencyKeyHash,input.requestHash]);
    const outcomeCode=optionalText(r.outcome_code); return { transactionId:uuid(r.transaction_id,"transaction_id"),budgetId:uuid(r.budget_id,"budget_id"),decision:text(r.decision,"decision"),...(outcomeCode===undefined?{}:{outcomeCode}),replayed:bool(r.replayed,"replayed") };
  }
  async reservePublication(input: ReservePublicationInput): Promise<ReservePublicationResult> { const r=await one(this.#executor,"select * from companion_private.reserve_publication($1,$2,$3,$4,$5)",[input.ownerId,input.companionId,input.relatedEventId,input.idempotencyKeyHash,input.requestHash]); const outcomeCode=optionalText(r.outcome_code); return {reservationId:uuid(r.reservation_id,"reservation_id"),budgetId:uuid(r.budget_id,"budget_id"),decision:text(r.decision,"decision"),...(outcomeCode===undefined?{}:{outcomeCode}),replayed:bool(r.replayed,"replayed")}; }
  async claimEncounter(input: ClaimEncounterInput): Promise<ClaimEncounterResult> { const r=await one(this.#executor,"select * from companion_private.claim_encounter_execution($1,$2,$3,$4,$5,$6,$7)",[input.actorOwnerId,input.idempotencyKeyHash,input.requestHash,input.encounterId,input.invitationId,input.generationTransactionId,input.publicationReservationId]); return {executionClaimId:uuid(r.execution_claim_id,"execution_claim_id"),encounterId:uuid(r.encounter_id,"encounter_id"),invitationId:uuid(r.invitation_id,"invitation_id"),claimedAt:timestamp(r.claimed_at,"claimed_at"),replayed:bool(r.replayed,"replayed")}; }
  async startCompute(ownerId:string, transactionId:string):Promise<StartComputeResult>{const r=await one(this.#executor,"select * from companion_private.start_compute_transaction($1,$2)",[ownerId,transactionId]);return {ledgerEntryId:uuid(r.ledger_entry_id,"ledger_entry_id"),ledgerSequence:integer(r.ledger_sequence,"ledger_sequence"),decision:text(r.decision,"decision"),replayed:bool(r.replayed,"replayed")};}
  async releaseCompute(ownerId:string,transactionId:string,outcomeCode:string):Promise<LedgerMutationResult>{const r=await one(this.#executor,"select * from companion_private.release_compute_transaction($1,$2,$3)",[ownerId,transactionId,outcomeCode]);return {ledgerEntryId:uuid(r.ledger_entry_id,"ledger_entry_id"),ledgerSequence:integer(r.ledger_sequence,"ledger_sequence"),decision:text(r.decision,"decision"),replayed:bool(r.replayed,"replayed")};}
  async releasePublication(ownerId:string,reservationId:string,outcomeCode:string):Promise<void>{await one(this.#executor,"select * from companion_private.complete_publication_reservation($1,$2,'RELEASED',$3)",[ownerId,reservationId,outcomeCode]);}
  async recordSafetyEvent(input:RecordSafetyEventInput):Promise<string>{const r=await one(this.#executor,"select * from companion_private.record_encounter_safety_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[input.id,input.ownerId,input.companionId,input.socialTwinId,input.direction,input.decision,[...input.threatTypes],input.contentHash,input.sanitizedContentHash??null,input.redactionCount,input.policyVersion,input.encounterId]);return uuid(r.safety_event_id,"safety_event_id");}
  async settleCompute(input:SettleComputeInput):Promise<LedgerMutationResult>{const r=await one(this.#executor,"select * from companion_private.settle_compute_transaction($1,$2,$3,$4,$5,$6,$7,$8)",[input.ownerId,input.transactionId,input.inputTokens,input.outputTokens,input.actualCostMinor,input.status,input.outcomeCode??null,input.providerRequestIdHash??null]);return {ledgerEntryId:uuid(r.ledger_entry_id,"ledger_entry_id"),ledgerSequence:integer(r.ledger_sequence,"ledger_sequence"),decision:text(r.decision,"decision"),replayed:bool(r.replayed,"replayed")};}
  async persistNonDelivery(input:PersistNonDeliveryInput):Promise<PersistNonDeliveryResult>{const r=await one(this.#executor,"select * from companion_private.persist_encounter_non_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[input.actorOwnerId,input.idempotencyKeyHash,input.requestHash,input.encounterId,input.invitationId,input.resultStatus,input.outcomeCode,input.generationTransactionId??null,input.publicationReservationId??null,input.safetyEventId??null,input.occurredAt]);const status=text(r.result_status,"result_status");if(status!=="BLOCKED"&&status!=="FAILED")throw new PostgresPersistenceError("DATABASE_ERROR","Invalid non-delivery status returned by PostgreSQL.");return {encounterId:uuid(r.encounter_id,"encounter_id"),resultStatus:status,outcomeCode:text(r.outcome_code,"outcome_code"),invitationConsumed:bool(r.invitation_consumed,"invitation_consumed"),publicationReleased:bool(r.publication_released,"publication_released"),replayed:bool(r.replayed,"replayed")};}
  async persistDelivery(input:PersistDeliveryInput):Promise<PersistDeliveryResult>{const r=await one(this.#executor,"select * from companion_private.persist_delivered_encounter($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[input.actorOwnerId,input.idempotencyKeyHash,input.requestHash,input.encounterId,input.invitationId,input.publicationReservationId,input.body,input.bodyHash,input.artifactStatus,input.generationTransactionId,input.outputSafetyEventId,input.occurredAt]);const status=text(r.result_status,"result_status");if(status!=="DELIVERED"&&status!=="REDACTED")throw new PostgresPersistenceError("DATABASE_ERROR","Invalid delivery status returned by PostgreSQL.");return {encounterId:uuid(r.encounter_id,"encounter_id"),artifactId:uuid(r.artifact_id,"artifact_id"),initiatorLifeEventId:uuid(r.initiator_life_event_id,"initiator_life_event_id"),responderLifeEventId:uuid(r.responder_life_event_id,"responder_life_event_id"),resultStatus:status,replayed:bool(r.replayed,"replayed")};}
  async listStaleStarted(cutoff:string,limit:number,after?:StaleStartedCursor):Promise<readonly StaleStartedCandidate[]>{
    try{const result=await this.#executor.query<Row>("select * from companion_private.list_stale_started_encounter_candidates($1,$2,$3,$4)",[cutoff,after?.staleAt??null,after?.executionClaimId??null,limit]);return result.rows.map(r=>({executionClaimId:uuid(r.execution_claim_id,"execution_claim_id"),actorOwnerId:uuid(r.actor_owner_id,"actor_owner_id"),encounterId:uuid(r.encounter_id,"encounter_id"),startedAt:timestamp(r.started_at,"started_at"),staleAt:timestamp(r.stale_at,"stale_at")}));}catch(error){return translate(error);}
  }
  async reconcileStarted(input:ReconcileStartedInput):Promise<ReconcileStartedResult>{const r=await one(this.#executor,"select * from companion_private.reconcile_stale_started_encounter($1,$2,$3,$4,$5)",[input.actorOwnerId,input.executionClaimId,input.reasonCode,input.evidenceSource,input.providerRequestIdHash??null]);const status=text(r.result_status,"result_status");if(status!=="FAILED")throw new PostgresPersistenceError("DATABASE_ERROR","Invalid reconciliation status returned by PostgreSQL.");return {encounterId:uuid(r.encounter_id,"encounter_id"),ledgerEntryId:uuid(r.ledger_entry_id,"ledger_entry_id"),resultStatus:status,outcomeCode:text(r.outcome_code,"outcome_code"),conservativeCostMinor:integer(r.conservative_cost_minor,"conservative_cost_minor"),invitationConsumed:bool(r.invitation_consumed,"invitation_consumed"),publicationReleased:bool(r.publication_released,"publication_released"),replayed:bool(r.replayed,"replayed")};}
}

export class PostgresOwnerReader {
  readonly #executor: SqlExecutor;
  constructor(executor: SqlExecutor) { this.#executor = executor; }
  async getComputeReceipt(transactionId:string):Promise<ComputeReceipt|undefined>{try{const result=await this.#executor.query<Row>("select * from public.get_compute_receipt($1)",[transactionId]);if(result.rows.length===0)return undefined;const r=result.rows[0]!;const socialTwinId=optionalText(r.social_twin_id);return {transactionId:uuid(r.transaction_id,"transaction_id"),ownerId:uuid(r.owner_id,"owner_id"),companionId:uuid(r.companion_id,"companion_id"),...(socialTwinId===undefined?{}:{socialTwinId}),reasonCode:text(r.reason_code,"reason_code") as ReasonCode,triggerEventType:text(r.trigger_event_type,"trigger_event_type"),triggerEventId:uuid(r.trigger_event_id,"trigger_event_id"),providerId:text(r.provider_id,"provider_id"),canonicalModel:text(r.canonical_model,"canonical_model"),providerModel:text(r.provider_model,"provider_model"),billingParty:text(r.billing_party,"billing_party") as BillingParty,currency:text(r.currency,"currency"),inputTokens:integer(r.input_tokens,"input_tokens"),outputTokens:integer(r.output_tokens,"output_tokens"),reservedCostMinor:integer(r.reserved_cost_minor,"reserved_cost_minor"),actualCostMinor:integer(r.actual_cost_minor,"actual_cost_minor"),outcome:text(r.outcome,"outcome"),promptTemplateVersion:text(r.prompt_template_version,"prompt_template_version"),identityVersion:integer(r.identity_version,"identity_version"),...(r.social_persona_version==null?{}:{socialPersonaVersion:integer(r.social_persona_version,"social_persona_version")}),memoryPolicyVersion:text(r.memory_policy_version,"memory_policy_version"),safetyPolicyVersion:text(r.safety_policy_version,"safety_policy_version"),routerVersion:text(r.router_version,"router_version"),attemptNo:integer(r.attempt_no,"attempt_no")};}catch(error){return translate(error);}}
}

export class PostgresOwnerAdapter extends PostgresOwnerReader {
  readonly #ownerExecutor:SqlExecutor;
  constructor(executor:SqlExecutor){super(executor);this.#ownerExecutor=executor;}
  async issueInvitation(input:IssueInvitationInput):Promise<InvitationMutationResult>{const r=await one(this.#ownerExecutor,"select * from public.issue_encounter_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[input.initiatorTwinId,input.responderTwinId,input.initiatorSocialPersonaId,input.responderSocialPersonaId,input.initiatorIdentityVersionId,input.responderIdentityVersionId,input.purpose,input.scope,input.contextHash,input.expiresAt,input.idempotencyKeyHash,input.requestHash]);return {invitationId:uuid(r.invitation_id,"invitation_id"),status:invitationStatus(r.status),occurredAt:timestamp(r.created_at,"created_at"),replayed:bool(r.replayed,"replayed")};}
  async approveInvitation(invitationId:string,idempotencyKeyHash:string,requestHash:string):Promise<InvitationMutationResult>{return this.#decision("approve_encounter_invitation",invitationId,idempotencyKeyHash,requestHash);}
  async rejectInvitation(invitationId:string,idempotencyKeyHash:string,requestHash:string):Promise<InvitationMutationResult>{return this.#decision("reject_encounter_invitation",invitationId,idempotencyKeyHash,requestHash);}
  async #decision(command:"approve_encounter_invitation"|"reject_encounter_invitation",invitationId:string,idempotencyKeyHash:string,requestHash:string):Promise<InvitationMutationResult>{const sql=command==="approve_encounter_invitation"?"select * from public.approve_encounter_invitation($1,$2,$3)":"select * from public.reject_encounter_invitation($1,$2,$3)";const r=await one(this.#ownerExecutor,sql,[invitationId,idempotencyKeyHash,requestHash]);return {invitationId:uuid(r.invitation_id,"invitation_id"),status:invitationStatus(r.status),occurredAt:timestamp(r.decided_at,"decided_at"),replayed:bool(r.replayed,"replayed")};}
  async listInvitations(limit:number,before?:InvitationListCursor):Promise<readonly OwnerInvitation[]>{try{const result=await this.#ownerExecutor.query<Row>("select * from public.list_encounter_invitations($1,$2,$3)",[limit,before?.createdAt??null,before?.invitationId??null]);return result.rows.map(r=>{const claimedAt=optionalTimestamp(r.claimed_at,"claimed_at"),usedAt=optionalTimestamp(r.used_at,"used_at");const role=text(r.role,"role");if(role!=="INITIATOR"&&role!=="RESPONDER")throw new PostgresPersistenceError("DATABASE_ERROR","Invalid invitation role returned by PostgreSQL.");return {invitationId:uuid(r.invitation_id,"invitation_id"),status:invitationStatus(r.status),role,initiatorOwnerId:uuid(r.initiator_owner_id,"initiator_owner_id"),initiatorTwinId:uuid(r.initiator_twin_id,"initiator_twin_id"),responderOwnerId:uuid(r.responder_owner_id,"responder_owner_id"),responderTwinId:uuid(r.responder_twin_id,"responder_twin_id"),purpose:text(r.purpose,"purpose"),scope:invitationScope(r.scope),contextHash:text(r.context_hash,"context_hash"),expiresAt:timestamp(r.expires_at,"expires_at"),...(claimedAt?{claimedAt}:{}),...(usedAt?{usedAt}:{}),createdAt:timestamp(r.created_at,"created_at")};});}catch(error){return translate(error);}}
  async getIdentityContext(input?:{readonly activeSubjectKind?:"OWNER"|"COMPANION"|"SOCIAL_TWIN";readonly activeSubjectId?:string}):Promise<ActiveIdentityContextView>{
    const r=await one(this.#ownerExecutor,"select * from public.get_active_identity_context($1,$2)",[input?.activeSubjectKind??"OWNER",input?.activeSubjectId??null]);
    return object(r.payload,"identity context") as unknown as ActiveIdentityContextView;
  }
  async listOwnerCompanions():Promise<readonly import("../../http/types.ts").OwnerCompanionSummaryView[]>{
    try{
      const result=await this.#ownerExecutor.query<Row>("select * from public.list_owner_companions()",[]);
      return Object.freeze(result.rows.map(r=>object(r.item,"Owner companion") as unknown as import("../../http/types.ts").OwnerCompanionSummaryView));
    }catch(error){return translate(error);}
  }
  async listWorldItems(limit:number,beforeCreatedAt?:string):Promise<WorldCollectionView>{
    try{
      const result=await this.#ownerExecutor.query<Row>("select * from public.list_world_items($1,$2)",[limit,beforeCreatedAt??null]);
      const items=result.rows.map(r=>object(r.item,"world item") as unknown as WorldCollectionView["items"][number]);
      const last=items.at(-1);
      return {items:Object.freeze(items),nextCursor:items.length===limit&&last!==undefined?last.publishedAt:null};
    }catch(error){return translate(error);}
  }
  async listLifeContinuity(
    limit:number,
    viewer?:{readonly activeSubjectKind:"OWNER"|"COMPANION"|"SOCIAL_TWIN";readonly activeSubjectId?:string},
    before?:{readonly occurredAt:string;readonly id:string},
  ):Promise<LifeContinuityCollectionView>{
    try{
      const result=await this.#ownerExecutor.query<Row>(
        "select * from public.list_life_continuity($1,$2,$3,$4,$5)",
        [viewer?.activeSubjectKind??"OWNER",viewer?.activeSubjectId??null,limit,before?.occurredAt??null,before?.id??null],
      );
      const items=result.rows.map(r=>object(r.item,"Life continuity item") as unknown as LifeContinuityItemView);
      const last=items.at(-1);
      return {
        items:Object.freeze(items),
        nextCursor:items.length===limit&&last!==undefined
          ? {beforeOccurredAt:last.occurredAt,beforeId:last.id}
          : null,
      };
    }catch(error){return translate(error);}
  }
  async getCompanionProfile(
    companionId:string,
    viewer?:{readonly activeSubjectKind:"OWNER"|"COMPANION"|"SOCIAL_TWIN";readonly activeSubjectId?:string},
  ):Promise<CompanionProfileView|undefined>{
    try{
      const result=await this.#ownerExecutor.query<Row>(
        "select * from public.get_companion_profile($1,$2,$3)",
        [companionId,viewer?.activeSubjectKind??"OWNER",viewer?.activeSubjectId??null],
      );
      if(result.rows.length===0)return undefined;
      return object(result.rows[0]!.payload,"companion profile") as unknown as CompanionProfileView;
    }catch(error){return translate(error);}
  }
  async getEncounterDetail(encounterId:string):Promise<EncounterDetailView|undefined>{
    try{
      const result=await this.#ownerExecutor.query<Row>("select * from public.get_encounter_detail($1)",[encounterId]);
      if(result.rows.length===0)return undefined;
      return object(result.rows[0]!.payload,"encounter detail") as unknown as EncounterDetailView;
    }catch(error){return translate(error);}
  }

  async listLifeEventInbox(limit:number,before?:{readonly createdAt:string;readonly id:string}):Promise<LifeEventInboxCollectionView>{
    try{
      const result=await this.#ownerExecutor.query<Row>("select * from public.list_life_event_inbox($1,$2,$3)",[limit,before?.createdAt??null,before?.id??null]);
      const items=result.rows.map(r=>object(r.item,"life event inbox item") as unknown as LifeEventInboxItemView);
      const last=items.at(-1);
      return {items:Object.freeze(items),nextCursor:items.length===limit&&last!==undefined?{beforeCreatedAt:last.createdAt,beforeId:last.id}:null};
    }catch(error){return translate(error);}
  }
  async acknowledgeLifeEvent(itemId:string):Promise<LifeEventInboxItemView|undefined>{
    try{
      const result=await this.#ownerExecutor.query<Row>("select * from public.ack_life_event_inbox_item($1)",[itemId]);
      if(result.rows.length===0)return undefined;
      return object(result.rows[0]!.item,"life event inbox item") as unknown as LifeEventInboxItemView;
    }catch(error){return translate(error);}
  }

  async getControls(companionId:string):Promise<ControlsResourceView|undefined>{
    try{
      const result=await this.#ownerExecutor.query<Row>("select * from public.get_companion_controls($1)",[companionId]);
      if(result.rows.length===0)return undefined;
      return object(result.rows[0]!.payload,"controls") as unknown as ControlsResourceView;
    }catch(error){return translate(error);}
  }
  async updateControls(input:{readonly companionId:string;readonly ifMatch:number;readonly patch:ControlsPatchInput;readonly idempotencyKeyHash:string;readonly requestHash:string}):Promise<ControlsResourceView|undefined>{
    try{
      const result=await this.#ownerExecutor.query<Row>("select * from public.update_companion_controls($1,$2,$3,$4,$5)",[input.companionId,input.ifMatch,input.patch,input.idempotencyKeyHash,input.requestHash]);
      if(result.rows.length===0)return undefined;
      return object(result.rows[0]!.payload,"controls") as unknown as ControlsResourceView;
    }catch(error){return translate(error);}
  }

  async createCompanionImport(input:{
    readonly rawPayload:string;
    readonly originalSha256:string;
    readonly byteLength:number;
    readonly parserVersion:string;
    readonly policyVersion:string;
    readonly sourceFormat:CompanionImportRecord["sourceFormat"];
    readonly draft:NormalizedIdentityDraft;
    readonly findings:readonly ImportFinding[];
    readonly idempotencyKeyHash:string;
    readonly requestHash:string;
  }):Promise<ImportReview>{
    const r=await one(this.#ownerExecutor,"select * from public.create_companion_import($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)",[
      input.rawPayload,input.originalSha256,input.byteLength,input.parserVersion,input.policyVersion,input.sourceFormat,
      JSON.stringify(input.draft),JSON.stringify(input.findings),input.idempotencyKeyHash,input.requestHash
    ]);
    return object(r.payload,"import review") as unknown as ImportReview;
  }
  async getCompanionImportReview(importId:string):Promise<ImportReview|undefined>{
    try{
      const result=await this.#ownerExecutor.query<Row>("select * from public.get_companion_import_review($1)",[importId]);
      if(result.rows.length===0)return undefined;
      return object(result.rows[0]!.payload,"import review") as unknown as ImportReview;
    }catch(error){return translate(error);}
  }
  async projectAndActivateSocialTwin(input:{
    readonly companionId:string;
    readonly sourceIdentityVersionId:string;
    readonly handle:string;
    readonly profileVisibility:"PRIVATE"|"FRIENDS"|"PUBLIC";
    readonly autonomyMode:"QUIET"|"NORMAL"|"ACTIVE"|"CUSTOM";
    readonly selections:readonly import("../../http/types.ts").ProjectionSelectionInput[];
    readonly idempotencyKeyHash:string;
    readonly requestHash:string;
  }):Promise<import("../../http/types.ts").ProjectionResultView>{
    const r=await one(this.#ownerExecutor,"select * from public.project_and_activate_social_twin($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",[
      input.companionId,input.sourceIdentityVersionId,input.handle,input.profileVisibility,input.autonomyMode,
      JSON.stringify(input.selections),input.idempotencyKeyHash,input.requestHash
    ]);
    return object(r.payload,"social projection") as unknown as import("../../http/types.ts").ProjectionResultView;
  }

  async approveCompanionImport(input:{
    readonly importId:string;
    readonly approvedCandidateIds:readonly string[];
    readonly companionId?:string;
    readonly idempotencyKeyHash:string;
    readonly requestHash:string;
  }):Promise<CompanionIdentity>{
    const r=await one(this.#ownerExecutor,"select * from public.approve_companion_import($1,$2,$3,$4,$5)",[
      input.importId,[...input.approvedCandidateIds],input.companionId??null,input.idempotencyKeyHash,input.requestHash
    ]);
    return object(r.payload,"companion identity") as unknown as CompanionIdentity;
  }

}
