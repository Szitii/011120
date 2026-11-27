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
const lifeEventsMigration = readFileSync(
  new URL("../supabase/migrations/202609130004_bounded_encounters_life_inbox.sql", import.meta.url),
  "utf8",
);
const atomicDeliveryMigration = readFileSync(
  new URL("../supabase/migrations/202609130007_atomic_publication_encounter_delivery.sql", import.meta.url),
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
    // Encounter was removed (run 2026-11-23, the rest 2026-11-27), and so were compute receipts.
    for (const gone of ["/encounters", "/encounter-invitations", "/compute-receipts"]) assert.ok(!openapi.includes(gone), gone);
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

  it("derives Owner-scoped Compute Receipts without sensitive bodies", () => {
    assert.match(atomicDeliveryMigration, /create or replace function public\.get_compute_receipt/);
    assert.match(atomicDeliveryMigration, /security invoker/);
    assert.match(atomicDeliveryMigration, /grant execute on function public\.get_compute_receipt\(uuid\) to authenticated/);
    assert.doesNotMatch(atomicDeliveryMigration, /prompt_body|completion_body|raw_memory|credential_id[\s,]/);
  });

  it("keeps Life Events Owner-only, immutable, and separate from Memory or Post", () => {
    assert.match(lifeEventsMigration, /create table public\.life_events/);
    assert.match(lifeEventsMigration, /visibility_domain text not null check \(visibility_domain = 'OWNER_ONLY'\)/);
    assert.match(lifeEventsMigration, /create trigger life_events_immutable[\s\S]*before update or delete/);
    assert.match(lifeEventsMigration, /comment on table public\.life_events is 'Owner-only event evidence; never automatically promoted to Memory or Post\.'/);
    assert.match(lifeEventsMigration, /create table public\.life_event_inbox/);
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

  it("keeps Owner presentation bounded and fail-closed", () => {
    assert.match(stage1PresentationMigration, /add column display_name text/);
    assert.match(stage1PresentationMigration, /'presentation',jsonb_strip_nulls/);
    assert.match(stage1PresentationMigration, /presentationAvailable',false/);
    assert.match(stage1PresentationMigration, /profile_visibility='PUBLIC'/);
    assert.doesNotMatch(stage1PresentationMigration, /identity_document|raw_payload/);
    assert.match(openapi, /required: \[kind, id, presentation\]/);
  });

  it("versions the six-surface MVP API and declares capability and error shapes", () => {
    assert.match(openapi, /version: 0\.7\.1/);
    assert.match(openapi, /operationId: listWorldItems/);
    assert.match(openapi, /operationId: listLifeContinuity/);
    for (const resource of ["\/world-items", "\/companions\/\{companionId\}\/profile", "\/life-event-inbox", "\/companion-imports", "\/controls"]) {
      assert.match(openapi, new RegExp(resource));
    }
    assert.match(openapi, /x-capability-status: implemented/);
    assert.match(openapi, /x-capability-status: contract-only/);
    assert.match(openapi, /messageClass: \{ enum: \[AUTH, PERMISSION, VALIDATION, CONFLICT, RATE_LIMIT, AVAILABILITY, CAPABILITY, INTERNAL\] \}/);
    assert.match(openapi, /retryHint: \{ enum: \[DO_NOT_RETRY, RETRY_SAME_REQUEST, RETRY_AFTER, REFRESH_AND_RETRY\] \}/);
    assert.doesNotMatch(openapi, /raw stack|private memory id|provider secret/i);
  });
});
