import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202609130001_v0_import_identity.sql", import.meta.url),
  "utf8",
);
const socialMemoryMigration = readFileSync(
  new URL("../supabase/migrations/202609130002_social_projection_memory_gate.sql", import.meta.url),
  "utf8",
);
const computeMigration = readFileSync(
  new URL("../supabase/migrations/202609130003_compute_ledger_budgets.sql", import.meta.url),
  "utf8",
);
const encounterMigration = readFileSync(
  new URL("../supabase/migrations/202609130004_bounded_encounters_life_inbox.sql", import.meta.url),
  "utf8",
);
const atomicDeliveryMigration = readFileSync(
  new URL("../supabase/migrations/202609130007_atomic_publication_encounter_delivery.sql", import.meta.url),
  "utf8",
);
const nonDeliveryMigration = readFileSync(
  new URL("../supabase/migrations/202609130008_atomic_encounter_non_delivery.sql", import.meta.url),
  "utf8",
);
const executionClaimMigration = readFileSync(
  new URL("../supabase/migrations/202609130009_pre_provider_encounter_claim.sql", import.meta.url),
  "utf8",
);
const staleRecoveryMigration = readFileSync(
  new URL("../supabase/migrations/202609130010_stale_unstarted_encounter_recovery.sql", import.meta.url),
  "utf8",
);
const supabaseSecurityMigration = readFileSync(
  new URL("../supabase/migrations/202609140011_supabase_security_baseline.sql", import.meta.url),
  "utf8",
);
const futureFunctionDefaultDenyMigration = readFileSync(
  new URL("../supabase/migrations/202609160012_future_function_default_deny.sql", import.meta.url),
  "utf8",
);
const startedReconciliationMigration = readFileSync(
  new URL("../supabase/migrations/202609160013_started_encounter_reconciliation.sql", import.meta.url),
  "utf8",
);
const reconciliationScanMigration = readFileSync(
  new URL("../supabase/migrations/202609160014_stale_started_candidate_scan.sql", import.meta.url),
  "utf8",
);
const invitationConsentMigration = readFileSync(
  new URL("../supabase/migrations/202609160015_encounter_invitation_consent.sql", import.meta.url),
  "utf8",
);
const encounterOrchestrationMigration = readFileSync(
  new URL("../supabase/migrations/202609160016_encounter_safety_command.sql", import.meta.url),
  "utf8",
);
const trustedContextMigration = readFileSync(
  new URL("../supabase/migrations/202609170017_trusted_encounter_context.sql", import.meta.url),
  "utf8",
);
const stage1PresentationMigration = readFileSync(
  new URL("../supabase/migrations/202609220028_stage1_identity_participant_presentation.sql", import.meta.url),
  "utf8",
);
const openapi = readFileSync(new URL("../../contracts/openapi/v0.yaml", import.meta.url), "utf8");
const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("Foundation persistence and API contracts", () => {
  it("keeps quarantine in a revoked private schema", () => {
    assert.match(migration, /create schema if not exists companion_private/);
    assert.match(migration, /revoke all on schema companion_private from public, anon, authenticated/);
    assert.match(migration, /companion_private\.companion_imports[\s\S]*raw_payload bytea not null/);
  });

  it("forces RLS and grants authenticated clients no direct write path", () => {
    for (const table of ["owners", "companions", "companion_identities", "audit_events"]) {
      assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`));
      assert.match(migration, new RegExp(`revoke insert, update, delete on public\\.${table} from anon, authenticated`));
    }
  });

  it("makes approved identity and audit rows append-only", () => {
    assert.match(migration, /create trigger companion_identities_immutable[\s\S]*before update or delete/);
    assert.match(migration, /create trigger audit_events_immutable[\s\S]*before update or delete/);
  });

  it("scopes identity and approval idempotency references to the Owner", () => {
    assert.match(migration, /foreign key \(companion_id, owner_id\) references public\.companions\(id, owner_id\)/);
    assert.match(migration, /foreign key \(identity_id, owner_id\) references public\.companion_identities\(id, owner_id\)/);
  });

  it("preserves bounded foundation APIs while namespacing the P1 community surface", () => {
    for (const path of [
      "/companion-imports:",
      "/companion-imports/{importId}:",
      "/companion-imports/{importId}/approve:",
      "/companions/{companionId}/identity-passport:",
      "/companions/{companionId}/social-persona:",
      "/memory-access-decisions:explain:",
      "/compute-transactions/{transactionId}:",
      "/life-event-inbox:",
    ]) {
      assert.ok(openapi.includes(path));
    }
    assert.doesNotMatch(openapi, /^  \/feed:/m);
    assert.ok(openapi.includes("/community/feed:"));
    assert.ok(!openapi.includes("/dm"));
    // The Encounter run, its invitations and receipts were removed: only reading an Encounter remains.
    assert.ok(openapi.includes("/encounters/{encounterId}:"));
    for (const gone of ["\n  /encounters:", "/encounter-invitations", "/compute-receipts"]) assert.ok(!openapi.includes(gone), gone);
    assert.match(openapi, /privateMemoryIncluded: \{ const: false \}/);
    assert.match(openapi, /socialRuntimeAuthority: \{ const: false \}/);
  });

  it("limits production runtime dependencies to the PostgreSQL driver and the pinned, Apache-2.0-licensed Claude SDK", () => {
    assert.deepEqual(packageManifest.dependencies, { "@anthropic-ai/sdk": "1.6.0", pg: "^8.23.0" });
  });

  it("replaces Supabase defaults with explicit Auth, Storage, and service-role boundaries", () => {
    assert.match(supabaseSecurityMigration, /revoke all on all tables in schema public from anon, authenticated/);
    assert.match(supabaseSecurityMigration, /grant select on table[\s\S]*to authenticated/);
    assert.match(supabaseSecurityMigration, /alter default privileges in schema public revoke execute on functions from public, anon, authenticated/);
    assert.match(supabaseSecurityMigration, /revoke all on schema companion_private from public, anon, authenticated/);
    assert.match(supabaseSecurityMigration, /'companion-import-quarantine',[\s\S]*false,[\s\S]*262144,[\s\S]*array\['application\/json'\]/);
    assert.match(supabaseSecurityMigration, /create policy companion_import_quarantine_service_only[\s\S]*to service_role/);
    assert.doesNotMatch(
      supabaseSecurityMigration,
      /create policy companion_import_quarantine_[\s\S]*?to (?:anon|authenticated)/,
    );
  });

  it("removes the creator role's global PUBLIC execute default for future functions", () => {
    assert.match(
      futureFunctionDefaultDenyMigration,
      /alter default privileges revoke execute on functions from public, anon, authenticated/,
    );
    assert.match(
      futureFunctionDefaultDenyMigration,
      /revoke execute on all functions in schema public from public, anon, authenticated/,
    );
    assert.match(
      futureFunctionDefaultDenyMigration,
      /revoke execute on all functions in schema companion_private from public, anon, authenticated/,
    );
    assert.match(
      futureFunctionDefaultDenyMigration,
      /grant execute on function public\.get_compute_receipt\(uuid\) to authenticated/,
    );
    assert.doesNotMatch(futureFunctionDefaultDenyMigration, /grant execute on all functions/);
  });

  it("separates private and social memory domains in the persistence contract", () => {
    assert.match(socialMemoryMigration, /namespace = 'PRIVATE' and domain in \('OWNER_ONLY', 'COMPANION_PRIVATE', 'RELATIONSHIP_PRIVATE'\)/);
    assert.match(socialMemoryMigration, /namespace = 'SOCIAL' and domain in \('FRIEND_SHAREABLE', 'SOCIAL', 'PUBLIC'\)/);
    assert.match(socialMemoryMigration, /revoke all on schema companion_private from public, anon, authenticated/);
  });

  it("makes SocialPersona and memory decision receipts immutable", () => {
    assert.match(socialMemoryMigration, /create trigger social_personas_immutable[\s\S]*before update or delete/);
    assert.match(socialMemoryMigration, /create trigger memory_access_receipts_immutable[\s\S]*before update or delete/);
  });

  it("keeps Compute attribution and ledger entries append-only", () => {
    assert.match(computeMigration, /create trigger compute_transactions_immutable[\s\S]*before update or delete/);
    assert.match(computeMigration, /create trigger compute_ledger_entries_immutable[\s\S]*before update or delete/);
    assert.match(computeMigration, /comment on table public\.compute_transactions is 'Immutable attribution envelope\. Prompt and completion bodies are prohibited\.'/);
  });

  it("reserves Compute atomically behind a private service-only command", () => {
    const atomicComputeMigration = readFileSync("backend/supabase/migrations/202609130005_atomic_compute_reservation.sql", "utf8");
    assert.match(atomicComputeMigration, /pg_advisory_xact_lock/);
    assert.match(atomicComputeMigration, /from public\.compute_budgets[\s\S]*for update/);
    assert.match(atomicComputeMigration, /rejection_code := 'BUDGET_EXHAUSTED'/);
    assert.match(atomicComputeMigration, /insert into public\.compute_transactions[\s\S]*insert into public\.compute_ledger_entries/);
    assert.match(atomicComputeMigration, /revoke all on function companion_private\.reserve_compute_transaction[\s\S]*from public, anon, authenticated/);
    assert.match(atomicComputeMigration, /grant execute on function companion_private\.reserve_compute_transaction[\s\S]*to service_role/);
  });

  it("persists the Compute lifecycle as private atomic state transitions", () => {
    const lifecycleMigration = readFileSync("backend/supabase/migrations/202609130006_atomic_compute_lifecycle.sql", "utf8");
    assert.match(lifecycleMigration, /create or replace function companion_private\.start_compute_transaction/);
    assert.match(lifecycleMigration, /create or replace function companion_private\.settle_compute_transaction/);
    assert.match(lifecycleMigration, /create or replace function companion_private\.release_compute_transaction/);
    assert.match(lifecycleMigration, /only a reserved compute transaction may start/);
    assert.match(lifecycleMigration, /only a started compute transaction may settle/);
    assert.match(lifecycleMigration, /only a reservation not sent to a provider may be released/);
    assert.match(lifecycleMigration, /set reserved_calls = reserved_calls - 1,[\s\S]*settled_calls = settled_calls \+ 1/);
    assert.match(lifecycleMigration, /revoke all on function companion_private\.settle_compute_transaction[\s\S]*from public, anon, authenticated/);
  });

  it("persists publication budgets separately from compute budgets", () => {
    assert.match(computeMigration, /create table public\.compute_budgets/);
    assert.match(computeMigration, /create table public\.publication_budgets/);
    assert.match(computeMigration, /create table public\.publication_reservations/);
  });

  it("makes publication capacity and successful Encounter delivery atomic", () => {
    assert.match(atomicDeliveryMigration, /create or replace function companion_private\.reserve_publication/);
    assert.match(atomicDeliveryMigration, /from public\.publication_budgets[\s\S]*for update/);
    assert.match(atomicDeliveryMigration, /PUBLICATION_BUDGET_EXHAUSTED/);
    assert.match(atomicDeliveryMigration, /create or replace function companion_private\.persist_delivered_encounter/);
    assert.match(atomicDeliveryMigration, /only successfully settled generation may be delivered/);
    assert.match(atomicDeliveryMigration, /output safety evidence does not authorize this artifact/);
    assert.match(atomicDeliveryMigration, /insert into public\.encounter_artifacts[\s\S]*insert into public\.life_events[\s\S]*insert into public\.life_event_inbox[\s\S]*complete_publication_reservation/);
    assert.match(atomicDeliveryMigration, /create trigger encounter_idempotency_immutable/);
    assert.match(atomicDeliveryMigration, /revoke all on function companion_private\.persist_delivered_encounter[\s\S]*from public, anon, authenticated/);
  });

  it("derives Owner-scoped Compute Receipts without sensitive bodies", () => {
    assert.match(atomicDeliveryMigration, /create or replace function public\.get_compute_receipt/);
    assert.match(atomicDeliveryMigration, /security invoker/);
    assert.match(atomicDeliveryMigration, /grant execute on function public\.get_compute_receipt\(uuid\) to authenticated/);
    assert.doesNotMatch(atomicDeliveryMigration, /prompt_body|completion_body|raw_memory|credential_id[\s,]/);
  });

  it("persists blocked and failed Encounter outcomes without delivery side effects", () => {
    assert.match(nonDeliveryMigration, /create or replace function companion_private\.persist_encounter_non_delivery/);
    assert.match(nonDeliveryMigration, /pre-provider non-delivery must be a current input safety block/);
    assert.match(nonDeliveryMigration, /entry\.entry_type = 'START'[\s\S]*invitation\.expires_at <= provider_start\.created_at/);
    assert.match(nonDeliveryMigration, /non-delivery result does not match terminal Compute status/);
    assert.match(nonDeliveryMigration, /terminal_compute\.outcome_code is distinct from p_outcome_code/);
    assert.match(nonDeliveryMigration, /complete_publication_reservation\([\s\S]*'RELEASED'/);
    assert.match(nonDeliveryMigration, /output safety evidence does not authorize this blocked result/);
    assert.doesNotMatch(nonDeliveryMigration, /insert into public\.(?:encounter_artifacts|life_events|life_event_inbox)/);
    assert.match(nonDeliveryMigration, /revoke all on function companion_private\.persist_encounter_non_delivery[\s\S]*from public, anon, authenticated/);
    assert.match(nonDeliveryMigration, /grant execute on function companion_private\.persist_encounter_non_delivery[\s\S]*to service_role/);
  });

  it("requires a durable one-shot execution claim before social provider start", () => {
    assert.match(executionClaimMigration, /add column claimed_at timestamptz/);
    assert.match(executionClaimMigration, /create table companion_private\.encounter_execution_claims/);
    assert.match(executionClaimMigration, /create or replace function companion_private\.claim_encounter_execution/);
    assert.match(executionClaimMigration, /compute_reservation\.entry_type <> 'RESERVATION'[\s\S]*compute_reservation\.status <> 'RESERVED'/);
    assert.match(executionClaimMigration, /publication_reservation\.status <> 'RESERVED'/);
    assert.match(executionClaimMigration, /create trigger compute_start_requires_encounter_claim/);
    assert.match(executionClaimMigration, /social Encounter provider start requires a durable execution claim/);
    assert.match(executionClaimMigration, /create trigger encounter_terminal_requires_execution_claim/);
    assert.match(executionClaimMigration, /new\.execution_claim_id := matching_claim\.id/);
    assert.match(executionClaimMigration, /revoke all on function companion_private\.claim_encounter_execution[\s\S]*from public, anon, authenticated/);
    assert.match(executionClaimMigration, /grant execute on function companion_private\.claim_encounter_execution[\s\S]*to service_role/);
  });

  it("recovers only stale claims that never reached provider start", () => {
    assert.match(staleRecoveryMigration, /create or replace function companion_private\.recover_stale_unstarted_encounter/);
    assert.match(staleRecoveryMigration, /least\(execution_claim\.claimed_at \+ interval '15 minutes', invitation\.expires_at\)/);
    assert.match(staleRecoveryMigration, /started Encounter execution requires provider reconciliation, not pre-provider recovery/);
    assert.match(staleRecoveryMigration, /release_compute_transaction[\s\S]*complete_publication_reservation[\s\S]*set used_at = recovery_time[\s\S]*insert into companion_private\.encounter_idempotency/);
    assert.match(staleRecoveryMigration, /STALE_CLAIM_RECOVERED_BEFORE_PROVIDER/);
    assert.match(staleRecoveryMigration, /new\.execution_claim_id := matching_claim\.id/);
    assert.doesNotMatch(staleRecoveryMigration, /insert into public\.(?:encounter_artifacts|life_events|life_event_inbox)/);
    assert.match(staleRecoveryMigration, /revoke all on function companion_private\.recover_stale_unstarted_encounter[\s\S]*from public, anon, authenticated/);
    assert.match(staleRecoveryMigration, /grant execute on function companion_private\.recover_stale_unstarted_encounter[\s\S]*to service_role/);
  });

  it("conservatively reconciles stale provider starts without delivery side effects", () => {
    assert.match(startedReconciliationMigration, /create table companion_private\.provider_call_reconciliations/);
    assert.match(startedReconciliationMigration, /for update[\s\S]*only an unsettled provider START may be reconciled/);
    assert.match(startedReconciliationMigration, /settled_cost_minor = settled_cost_minor \+ compute_transaction\.reserved_cost_minor/);
    assert.match(startedReconciliationMigration, /'RECONCILIATION', 'RECONCILED'/);
    assert.match(startedReconciliationMigration, /complete_publication_reservation[\s\S]*set used_at = reconciliation_time[\s\S]*insert into companion_private\.encounter_idempotency/);
    assert.match(startedReconciliationMigration, /STARTED_PROVIDER_OUTCOME_UNKNOWN/);
    assert.doesNotMatch(startedReconciliationMigration, /insert into public\.(?:encounter_artifacts|life_events|life_event_inbox)/);
    assert.match(startedReconciliationMigration, /revoke all on function companion_private\.reconcile_stale_started_encounter[\s\S]*from public, anon, authenticated/);
    assert.match(startedReconciliationMigration, /grant execute on function companion_private\.reconcile_stale_started_encounter[\s\S]*to service_role/);
  });

  it("exposes a bounded service-only stale START candidate scan", () => {
    assert.match(reconciliationScanMigration, /create or replace function companion_private\.list_stale_started_encounter_candidates/);
    assert.match(reconciliationScanMigration, /p_limit between 1 and 100/);
    assert.match(reconciliationScanMigration, /latest_compute\.entry_type = 'START'[\s\S]*latest_compute\.status = 'STARTED'/);
    assert.match(reconciliationScanMigration, /invitation\.used_at is null/);
    assert.match(reconciliationScanMigration, /not exists \([\s\S]*companion_private\.encounter_idempotency/);
    assert.match(reconciliationScanMigration, /revoke all on function companion_private\.list_stale_started_encounter_candidates[\s\S]*from public, anon, authenticated/);
    assert.match(reconciliationScanMigration, /grant execute on function companion_private\.list_stale_started_encounter_candidates[\s\S]*to service_role/);
    assert.doesNotMatch(reconciliationScanMigration, /insert into public\.(?:encounter_artifacts|life_events|life_event_inbox)/);
  });

  it("requires authenticated dual-Owner consent before an invitation becomes claimable",()=>{
    assert.match(invitationConsentMigration,/create or replace function public\.issue_encounter_invitation/);
    assert.match(invitationConsentMigration,/auth\.uid\(\)/);
    assert.match(invitationConsentMigration,/values\(new_id,actor\.id[\s\S]*array\[actor\.id\][\s\S]*'PENDING'/);
    assert.match(invitationConsentMigration,/create or replace function public\.approve_encounter_invitation/);
    assert.match(invitationConsentMigration,/actor\.id=invitation\.initiator_owner_id[\s\S]*issuer approval was fixed at issuance/);
    assert.match(invitationConsentMigration,/expired invitation cannot be decided/);
    assert.match(invitationConsentMigration,/invitation persona or Identity Passport version is stale/);
    assert.match(invitationConsentMigration,/create table companion_private\.encounter_invitation_decisions/);
    assert.match(invitationConsentMigration,/revoke all on function public\.issue_encounter_invitation[\s\S]*from public,anon/);
    assert.doesNotMatch(invitationConsentMigration,/insert into public\.(?:compute_transactions|publication_reservations|encounter_artifacts|life_events|life_event_inbox)/);
  });

  it("persists only DLP-cleared Encounter artifacts and hash-only private safety evidence", () => {
    assert.match(encounterMigration, /create table public\.encounter_artifacts/);
    assert.match(encounterMigration, /status text not null check \(status in \('DELIVERED', 'REDACTED'\)\)/);
    assert.match(encounterMigration, /create table companion_private\.encounter_safety_events/);
    assert.match(encounterMigration, /content_hash text not null/);
    assert.doesNotMatch(encounterMigration, /raw_(?:input|output)|blocked_content|prompt_body|completion_body/);
    assert.match(encounterMigration, /create trigger encounter_artifacts_immutable[\s\S]*before update or delete/);
    assert.match(encounterMigration, /create trigger encounter_safety_events_immutable[\s\S]*before update or delete/);
  });

  it("keeps persistent orchestration evidence and replay service-only",()=>{
    assert.match(encounterOrchestrationMigration,/create or replace function companion_private\.record_encounter_safety_event/);
    assert.match(encounterOrchestrationMigration,/create or replace function companion_private\.get_encounter_terminal_result/);
    assert.match(encounterOrchestrationMigration,/revoke all on function companion_private\.record_encounter_safety_event[\s\S]*from public, anon, authenticated/);
    assert.match(encounterOrchestrationMigration,/revoke all on function companion_private\.get_encounter_terminal_result[\s\S]*from public, anon, authenticated/);
    assert.doesNotMatch(encounterOrchestrationMigration,/prompt|completion|credential|memory_body/i);
  });

  it("assembles immutable claim-bound context after permission-first descriptor filtering",()=>{
    assert.match(trustedContextMigration,/create table companion_private\.encounter_context_snapshots/);
    assert.match(trustedContextMigration,/execution_claim_id uuid not null unique/);
    assert.match(trustedContextMigration,/create trigger encounter_context_snapshots_immutable/);
    assert.match(trustedContextMigration,/Descriptor and permission predicates materialize before the representation join reads summaries/);
    assert.match(trustedContextMigration,/authorized_descriptors as materialized/);
    assert.match(trustedContextMigration,/m\.namespace='SOCIAL'/);
    assert.match(trustedContextMigration,/m\.domain in \('FRIEND_SHAREABLE','SOCIAL','PUBLIC'\)/);
    assert.match(trustedContextMigration,/p\.purpose='SOCIAL_ENCOUNTER'/);
    assert.match(trustedContextMigration,/m\.revoked_at is null/);
    assert.doesNotMatch(trustedContextMigration,/content_plaintext|content_ciphertext/);
    assert.match(trustedContextMigration,/revoke all on function companion_private\.assemble_encounter_context[\s\S]*from public,anon,authenticated/);
  });

  it("requires mutual Owner approval and models Encounter capabilities as one-shot", () => {
    assert.match(encounterMigration, /approved_by_owner_ids @> array\[initiator_owner_id, responder_owner_id\]/);
    assert.match(encounterMigration, /max_uses integer not null default 1 check \(max_uses = 1\)/);
    assert.match(encounterMigration, /check \(expires_at > created_at\)/);
    assert.match(encounterMigration, /create trigger encounter_invitations_consume_only[\s\S]*before update or delete/);
    assert.match(encounterMigration, /old\.used_at is not null[\s\S]*new\.used_at is null/);
  });

  it("keeps Life Events Owner-only, immutable, and separate from Memory or Post", () => {
    assert.match(encounterMigration, /create table public\.life_events/);
    assert.match(encounterMigration, /visibility_domain text not null check \(visibility_domain = 'OWNER_ONLY'\)/);
    assert.match(encounterMigration, /create trigger life_events_immutable[\s\S]*before update or delete/);
    assert.match(encounterMigration, /comment on table public\.life_events is 'Owner-only event evidence; never automatically promoted to Memory or Post\.'/);
    assert.match(encounterMigration, /create table public\.life_event_inbox/);
  });

  it("persists Bring Companion behind private quarantine and atomic approval", () => {
    const bringCompanionMigration = readFileSync(new URL("../supabase/migrations/202609180022_stage1_bring_companion_http.sql", import.meta.url), "utf8");
    assert.match(bringCompanionMigration, /create or replace function public\.create_companion_import/);
    assert.match(bringCompanionMigration, /companion_private\.companion_imports/);
    assert.match(bringCompanionMigration, /convert_to\(p_raw_payload,'UTF8'\)/);
    assert.match(bringCompanionMigration, /idempotency key reused with a different request/);
    assert.match(bringCompanionMigration, /create or replace function public\.approve_companion_import/);
    assert.match(bringCompanionMigration, /blocked identity candidate cannot be approved/);
    assert.match(bringCompanionMigration, /insert into public\.companion_identities/);
    assert.match(bringCompanionMigration, /update public\.companions set current_identity_version_id/);
    assert.doesNotMatch(bringCompanionMigration, /raw_payload[^;]*return query/i);
  });

  it("keeps Owner and Encounter presentation bounded and fail-closed", () => {
    assert.match(stage1PresentationMigration, /add column display_name text/);
    assert.match(stage1PresentationMigration, /'presentation',jsonb_strip_nulls/);
    assert.match(stage1PresentationMigration, /presentationAvailable',false/);
    assert.match(stage1PresentationMigration, /profile_visibility='PUBLIC'/);
    assert.doesNotMatch(stage1PresentationMigration, /identity_document|raw_payload/);
    assert.match(openapi, /required: \[kind, id, presentation\]/);
    assert.match(openapi, /participants:/);
  });

  it("versions the six-surface MVP API and declares capability and error shapes", () => {
    assert.match(openapi, /version: 0\.7\.1/);
    assert.match(openapi, /operationId: listWorldItems/);
    assert.match(openapi, /operationId: listLifeContinuity/);
    for (const resource of ["\/world-items", "\/companions\/\{companionId\}\/profile", "\/encounters\/\{encounterId\}", "\/life-event-inbox", "\/companion-imports", "\/controls"]) {
      assert.match(openapi, new RegExp(resource));
    }
    assert.match(openapi, /x-capability-status: implemented/);
    assert.match(openapi, /x-capability-status: contract-only/);
    assert.match(openapi, /messageClass: \{ enum: \[AUTH, PERMISSION, VALIDATION, CONFLICT, RATE_LIMIT, AVAILABILITY, CAPABILITY, INTERNAL\] \}/);
    assert.match(openapi, /retryHint: \{ enum: \[DO_NOT_RETRY, RETRY_SAME_REQUEST, RETRY_AFTER, REFRESH_AND_RETRY\] \}/);
    assert.doesNotMatch(openapi, /raw stack|private memory id|provider secret/i);
  });
});
