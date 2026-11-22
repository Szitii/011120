create or replace function public.test_assert(condition boolean, message text)
returns void
language plpgsql
as $$
begin
  if not condition then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;
grant execute on function public.test_assert(boolean, text) to authenticated, service_role;

select public.test_assert(
  exists (
    select 1
    from storage.buckets
    where id = 'companion-import-quarantine'
      and not public
      and file_size_limit = 262144
      and allowed_mime_types = array['application/json']::text[]
  ),
  'quarantine Storage bucket must be private and bounded to the JSON import envelope'
);
select public.test_assert(
  not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (roles @> array['anon']::name[] or roles @> array['authenticated']::name[])
  ),
  'quarantine Storage objects must expose no anon or authenticated policy'
);
select public.test_assert(
  exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'companion_import_quarantine_service_only'
      and roles @> array['service_role']::name[]
  ),
  'quarantine Storage objects must document their service-role-only boundary'
);

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000c1');

insert into public.owners (id, auth_user_id) values
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000001c1', '00000000-0000-0000-0000-0000000000c1');

insert into public.companions (id, owner_id, status, origin_type) values
  ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000001a1', 'ACTIVE', 'IMPORTED_CARD'),
  ('00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000001b1', 'ACTIVE', 'IMPORTED_CARD');

insert into public.companion_identities
  (id, owner_id, companion_id, version, display_name, identity_document, source_manifest, content_hash, created_by, approved_by_owner_at)
values
  ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1', 1, 'A', '{}', '{}', repeat('a', 64), 'IMPORT_FIREWALL', now()),
  ('00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1', 1, 'B', '{}', '{}', repeat('b', 64), 'IMPORT_FIREWALL', now());

update public.companions set current_identity_version_id = '00000000-0000-0000-0000-0000000003a1'
where id = '00000000-0000-0000-0000-0000000002a1';
update public.companions set current_identity_version_id = '00000000-0000-0000-0000-0000000003b1'
where id = '00000000-0000-0000-0000-0000000002b1';

insert into public.social_handles (handle, owner_id, companion_id) values
  ('companion_a', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1'),
  ('companion_b', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1');

insert into public.social_personas
  (id, owner_id, companion_id, version, handle, display_name, public_document, profile_visibility,
   source_identity_version_id, source_identity_version, source_identity_content_hash, projection_manifest,
   content_hash, approved_by_owner_at)
values
  ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1', 1, 'companion_a', 'A', '{}', 'PUBLIC', '00000000-0000-0000-0000-0000000003a1', 1, repeat('a', 64), '[]', repeat('a', 64), now()),
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1', 1, 'companion_b', 'B', '{}', 'PUBLIC', '00000000-0000-0000-0000-0000000003b1', 1, repeat('b', 64), '[]', repeat('b', 64), now());

insert into public.social_twins
  (id, owner_id, companion_id, active_social_persona_id, status, autonomy_mode)
values
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000004a1', 'ACTIVE', 'QUIET'),
  ('00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000004b1', 'ACTIVE', 'QUIET');

insert into public.compute_transactions
  (id, owner_id, companion_id, social_twin_id, reason_code, trigger_event_type, trigger_event_id,
   provider_id, canonical_model, provider_model, billing_party, currency, pricing_version,
   prompt_template_version, identity_version, social_persona_version, memory_policy_version,
   safety_policy_version, router_version, trace_id, idempotency_key_hash)
values
  ('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000005b1',
   'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER', '00000000-0000-0000-0000-0000000008a1',
   'test-provider', 'small-text', 'test-small', 'OWNER', 'USD', 'test/1', 'encounter/0.1.0', 1, 1,
   'memory/1', 'safety/1', 'router/1', 'trace-test', repeat('c', 64));

insert into companion_private.encounter_safety_events
  (id, owner_id, companion_id, social_twin_id, direction, surface, threat_types, decision,
   content_hash, redaction_count, policy_version, related_encounter_id)
values
  ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1',
   '00000000-0000-0000-0000-0000000005b1', 'OUTPUT', 'ENCOUNTER', '{}', 'ALLOW', repeat('d', 64), 0,
   'safety/1', '00000000-0000-0000-0000-0000000008a1');

insert into public.encounter_invitations
  (id, initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
   approved_by_owner_ids, purpose, expires_at)
values
  ('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1',
   '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000005b1',
   array['00000000-0000-0000-0000-0000000001a1'::uuid, '00000000-0000-0000-0000-0000000001b1'::uuid],
   'RLS integration test', now() + interval '1 day');

insert into public.encounter_artifacts
  (id, invitation_id, initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
   body, status, generation_transaction_id, safety_event_id)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000008a1',
   '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1',
   '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000005b1',
   'DLP-cleared test artifact', 'DELIVERED', '00000000-0000-0000-0000-0000000006b1',
   '00000000-0000-0000-0000-0000000007b1');

insert into public.life_events
  (id, owner_id, companion_id, kind, title, structured_state, source, visibility_domain,
   occurred_at, decision_transaction_id, idempotency_key)
values
  ('00000000-0000-0000-0000-0000000010a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1',
   'SOCIAL_ENCOUNTER', 'Encounter complete', '{"artifact":"00000000-0000-0000-0000-0000000009a1"}', 'SOCIAL', 'OWNER_ONLY', now(),
   '00000000-0000-0000-0000-0000000006b1', 'life-a'),
  ('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1',
   'SOCIAL_ENCOUNTER', 'Encounter complete', '{"artifact":"00000000-0000-0000-0000-0000000009a1"}', 'SOCIAL', 'OWNER_ONLY', now(),
   '00000000-0000-0000-0000-0000000006b1', 'life-b');

insert into public.life_event_inbox
  (id, owner_id, companion_id, life_event_id, title)
values
  ('00000000-0000-0000-0000-0000000011a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000010a1', 'Encounter complete'),
  ('00000000-0000-0000-0000-0000000011b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000010b1', 'Encounter complete');

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select public.test_assert((select count(*) from public.companions) = 1, 'Owner A must see only its Companion');
select public.test_assert((select count(*) from public.encounter_invitations) = 1, 'Owner A must see its shared invitation');
select public.test_assert((select count(*) from public.encounter_artifacts) = 1, 'Owner A must see its shared artifact');
select public.test_assert((select count(*) from public.life_events) = 1, 'Owner A must see only its Life Event');
select public.test_assert((select count(*) from public.life_event_inbox) = 1, 'Owner A must see only its Inbox item');
select public.test_assert((select count(*) from public.compute_transactions) = 0, 'Owner A must not see Owner B billing');
select public.test_assert(not has_schema_privilege('authenticated', 'companion_private', 'USAGE'), 'private schema must remain inaccessible');
select public.test_assert(not has_table_privilege('authenticated', 'public.life_events', 'INSERT'), 'clients must not write Life Events');

select set_config('request.jwt.claim.sub', '', false);
select public.test_assert((select count(*) from public.companions) = 0, 'missing Auth subject claim must fail closed');

do $$
begin
  begin
    insert into storage.objects (bucket_id, name, owner_id)
    values ('companion-import-quarantine', 'spoofed/a.json', '00000000-0000-0000-0000-0000000000a1');
    raise exception 'authenticated quarantine upload unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select public.test_assert((select count(*) from public.companions) = 0, 'unrelated Owner must see no Companions');
select public.test_assert((select count(*) from public.encounter_invitations) = 0, 'unrelated Owner must see no invitations');
select public.test_assert((select count(*) from public.encounter_artifacts) = 0, 'unrelated Owner must see no artifacts');
select public.test_assert((select count(*) from public.life_events) = 0, 'unrelated Owner must see no Life Events');
select public.test_assert((select count(*) from public.life_event_inbox) = 0, 'unrelated Owner must see no Inbox items');
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
reset role;
select public.test_assert(
  not has_table_privilege('anon', 'public.companions', 'SELECT'),
  'anon must not gain Owner visibility by spoofing a subject claim'
);

set role service_role;
insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
  'companion-import-quarantine',
  'service/import-a.json',
  '00000000-0000-0000-0000-0000000000a1',
  '{"contentType":"application/json"}'::jsonb
);
reset role;
select public.test_assert(
  (select count(*) = 1 from storage.objects
   where bucket_id = 'companion-import-quarantine' and name = 'service/import-a.json'),
  'service role must retain the Storage API path for bounded quarantine objects'
);

create table public.default_grant_probe (id bigint primary key);
create sequence public.default_sequence_probe;
create function public.default_function_probe()
returns bigint
language sql
as $$ select 1::bigint $$;

select public.test_assert(
  (select pg_get_userbyid(proowner) = current_user
   from pg_proc
   where oid = 'public.default_function_probe()'::regprocedure),
  'future-function probe must be owned by the migration creator role'
);
select public.test_assert(
  exists (
    select 1
    from pg_default_acl
    where defaclrole = (select oid from pg_roles where rolname = current_user)
      and defaclnamespace = 0
      and defaclobjtype = 'f'
  ),
  'future-function default ACL must be bound to the migration creator role'
);

select public.test_assert(
  not has_table_privilege('authenticated', 'public.default_grant_probe', 'SELECT'),
  'future public tables must not inherit authenticated access'
);
select public.test_assert(
  not has_sequence_privilege('authenticated', 'public.default_sequence_probe', 'USAGE'),
  'future public sequences must not inherit authenticated access'
);
select public.test_assert(
  not exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid = 'public.default_function_probe()'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'future public functions must not inherit PUBLIC execution'
);
select public.test_assert(
  not has_function_privilege('authenticated', 'public.default_function_probe()'::regprocedure, 'EXECUTE'),
  'future public functions must not inherit authenticated execution'
);
select public.test_assert(
  not has_function_privilege('anon', 'public.default_function_probe()'::regprocedure, 'EXECUTE'),
  'future public functions must not inherit anon execution'
);

drop function public.default_function_probe();
drop sequence public.default_sequence_probe;
drop table public.default_grant_probe;

update public.encounter_invitations
set claimed_at = now()
where id = '00000000-0000-0000-0000-0000000008a1';
update public.encounter_invitations
set used_at = now()
where id = '00000000-0000-0000-0000-0000000008a1';

do $$
begin
  begin
    update public.encounter_invitations
    set purpose = 'forbidden mutation'
    where id = '00000000-0000-0000-0000-0000000008a1';
    raise exception 'invitation mutation unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'Encounter invitations may only be claimed once and consumed once' then
      raise;
    end if;
  end;

  begin
    update public.encounter_artifacts
    set body = 'forbidden mutation'
    where id = '00000000-0000-0000-0000-0000000009a1';
    raise exception 'artifact mutation unexpectedly succeeded';
  exception when sqlstate '55000' then
    null;
  end;

  begin
    insert into public.encounter_invitations
      (initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
       approved_by_owner_ids, purpose, expires_at)
    values
      ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1',
       '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000005b1',
       array['00000000-0000-0000-0000-0000000001a1'::uuid], 'missing consent', now() + interval '1 day');
    raise exception 'single-Owner invitation unexpectedly succeeded';
  exception when check_violation then
    null;
  end;
end;
$$;

select public.test_assert(
  (select source_identity_version from public.social_personas where id = '00000000-0000-0000-0000-0000000004a1') = 1,
  'identity version must persist with SocialPersona'
);

select public.test_assert(
  not has_schema_privilege('authenticated', 'companion_private', 'USAGE'),
  'authenticated clients must not reach private transaction commands'
);

insert into public.compute_budgets (
  id, owner_id, companion_id, period_start, period_end, max_model_calls,
  max_input_tokens, max_output_tokens, max_cost_minor, currency
) values (
  '00000000-0000-0000-0000-0000000012a1',
  '00000000-0000-0000-0000-0000000001a1',
  '00000000-0000-0000-0000-0000000002a1',
  now() - interval '1 hour', now() + interval '1 hour', 1, 4000, 800, 100, 'USD'
);

set role service_role;
create temporary table first_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001a1',
  '00000000-0000-0000-0000-0000000002a1',
  '00000000-0000-0000-0000-0000000005a1',
  'OWNER_DIRECT_RESPONSE',
  'OWNER_REQUEST',
  '00000000-0000-0000-0000-0000000008a1',
  'test-provider',
  null,
  'small-text',
  'test-small',
  'OWNER',
  'USD',
  'test/1',
  100,
  200,
  25,
  'encounter/0.1.0',
  1,
  1,
  'memory/1',
  'safety/1',
  'router/1',
  'trace-atomic-reserve',
  1,
  null,
  repeat('e', 64),
  repeat('f', 64)
);
reset role;

select public.test_assert(
  (select decision = 'RESERVED' and not replayed from first_compute_reservation),
  'first valid reservation must atomically succeed'
);
select public.test_assert(
  (select reserved_calls = 1 and reserved_input_tokens = 100 and reserved_output_tokens = 200 and reserved_cost_minor = 25
   from public.compute_budgets where id = '00000000-0000-0000-0000-0000000012a1'),
  'reservation must update every hard-cap counter in the same transaction'
);
select public.test_assert(
  (select count(*) = 1 from public.compute_ledger_entries
   where transaction_id = (select transaction_id from first_compute_reservation)
     and sequence = 1 and entry_type = 'RESERVATION' and status = 'RESERVED'),
  'reservation must append its immutable first ledger fact'
);

select public.test_assert(
  (select replayed and decision = 'RESERVED'
   from companion_private.reserve_compute_transaction(
    '00000000-0000-0000-0000-0000000001a1',
    '00000000-0000-0000-0000-0000000002a1',
    '00000000-0000-0000-0000-0000000005a1',
    'OWNER_DIRECT_RESPONSE', 'OWNER_REQUEST', '00000000-0000-0000-0000-0000000008a1',
    'test-provider', null, 'small-text', 'test-small', 'OWNER', 'USD', 'test/1',
    100, 200, 25, 'encounter/0.1.0', 1, 1, 'memory/1', 'safety/1', 'router/1',
    'trace-atomic-reserve', 1, null, repeat('e', 64), repeat('f', 64)
  )),
  'identical retry must return the original reservation without double spending'
);
select public.test_assert(
  (select reserved_calls = 1 from public.compute_budgets where id = '00000000-0000-0000-0000-0000000012a1'),
  'idempotent replay must not reserve budget twice'
);

create temporary table rejected_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001a1',
  '00000000-0000-0000-0000-0000000002a1',
  '00000000-0000-0000-0000-0000000005a1',
  'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER', '00000000-0000-0000-0000-0000000008a1',
  'test-provider', null, 'small-text', 'test-small', 'OWNER', 'USD', 'test/1',
  100, 200, 25, 'encounter/0.1.0', 1, 1, 'memory/1', 'safety/1', 'router/1',
  'trace-budget-rejection', 1, null, repeat('0', 64), repeat('1', 64)
);

select public.test_assert(
  (select decision = 'REJECTED' and outcome_code = 'BUDGET_EXHAUSTED' from rejected_compute_reservation),
  'hard-cap exhaustion must fail closed'
);
select public.test_assert(
  (select count(*) = 1 from public.compute_ledger_entries
   where transaction_id = (select transaction_id from rejected_compute_reservation)
     and entry_type = 'REJECTION' and outcome_code = 'BUDGET_EXHAUSTED'),
  'budget rejection must remain attributable in the immutable ledger'
);

do $$
begin
  begin
    perform companion_private.reserve_compute_transaction(
      '00000000-0000-0000-0000-0000000001a1',
      '00000000-0000-0000-0000-0000000002a1',
      '00000000-0000-0000-0000-0000000005a1',
      'OWNER_DIRECT_RESPONSE', 'OWNER_REQUEST', '00000000-0000-0000-0000-0000000008a1',
      'test-provider', null, 'small-text', 'test-small', 'OWNER', 'USD', 'test/1',
      100, 200, 25, 'encounter/0.1.0', 1, 1, 'memory/1', 'safety/1', 'router/1',
      'trace-substitution', 1, null, repeat('e', 64), repeat('2', 64)
    );
    raise exception 'idempotency substitution unexpectedly succeeded';
  exception when unique_violation then
    null;
  end;
end;
$$;

set role service_role;
create temporary table started_compute_transaction as
select * from companion_private.start_compute_transaction(
  '00000000-0000-0000-0000-0000000001a1',
  (select transaction_id from first_compute_reservation)
);
reset role;

select public.test_assert(
  (select decision = 'STARTED' and ledger_sequence = 2 and not replayed from started_compute_transaction),
  'provider start must append exactly one START fact'
);
select public.test_assert(
  (select replayed and ledger_sequence = 2
   from companion_private.start_compute_transaction(
     '00000000-0000-0000-0000-0000000001a1',
     (select transaction_id from first_compute_reservation)
   )),
  'repeated provider start must return the original START fact'
);

set role service_role;
create temporary table settled_compute_transaction as
select * from companion_private.settle_compute_transaction(
  '00000000-0000-0000-0000-0000000001a1',
  (select transaction_id from first_compute_reservation),
  90,
  150,
  20,
  'SUCCEEDED',
  'DELIVERED',
  repeat('a', 64)
);
reset role;

select public.test_assert(
  (select decision = 'SUCCEEDED' and ledger_sequence = 3 and not replayed from settled_compute_transaction),
  'settlement must append one terminal ledger fact'
);
select public.test_assert(
  (select reserved_calls = 0 and settled_calls = 1
     and reserved_input_tokens = 0 and settled_input_tokens = 90
     and reserved_output_tokens = 0 and settled_output_tokens = 150
     and reserved_cost_minor = 0 and settled_cost_minor = 20
   from public.compute_budgets where id = '00000000-0000-0000-0000-0000000012a1'),
  'settlement must atomically transfer reserved counters to actual settled usage'
);
select public.test_assert(
  (select replayed and ledger_sequence = 3
   from companion_private.settle_compute_transaction(
     '00000000-0000-0000-0000-0000000001a1',
     (select transaction_id from first_compute_reservation),
     90, 150, 20, 'SUCCEEDED', 'DELIVERED', repeat('a', 64)
   )),
  'identical settlement replay must not charge twice'
);

do $$
begin
  begin
    perform companion_private.settle_compute_transaction(
      '00000000-0000-0000-0000-0000000001a1',
      (select transaction_id from first_compute_reservation),
      90, 150, 21, 'SUCCEEDED', 'DELIVERED', repeat('a', 64)
    );
    raise exception 'settlement substitution unexpectedly succeeded';
  exception when unique_violation then
    null;
  end;
end;
$$;

insert into public.compute_budgets (
  id, owner_id, companion_id, period_start, period_end, max_model_calls,
  max_input_tokens, max_output_tokens, max_cost_minor, currency
) values (
  '00000000-0000-0000-0000-0000000012b1',
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  now() - interval '1 hour', now() + interval '1 hour', 1, 4000, 800, 100, 'USD'
);

set role service_role;
create temporary table releasable_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1',
  'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER', '00000000-0000-0000-0000-0000000008a1',
  'test-provider', null, 'small-text', 'test-small', 'OWNER', 'USD', 'test/1',
  100, 200, 25, 'encounter/0.1.0', 1, 1, 'memory/1', 'safety/1', 'router/1',
  'trace-release', 1, null, repeat('3', 64), repeat('4', 64)
);
create temporary table released_compute_transaction as
select * from companion_private.release_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from releasable_compute_reservation),
  'CANCELLED_BEFORE_PROVIDER'
);
reset role;

select public.test_assert(
  (select decision = 'CANCELLED' and ledger_sequence = 2 and not replayed from released_compute_transaction),
  'release must append one terminal cancellation fact'
);
select public.test_assert(
  (select reserved_calls = 0 and settled_calls = 0 and reserved_cost_minor = 0 and settled_cost_minor = 0
   from public.compute_budgets where id = '00000000-0000-0000-0000-0000000012b1'),
  'release before provider I/O must restore reserved capacity without settled charge'
);
select public.test_assert(
  (select replayed and ledger_sequence = 2
   from companion_private.release_compute_transaction(
     '00000000-0000-0000-0000-0000000001b1',
     (select transaction_id from releasable_compute_reservation),
     'CANCELLED_BEFORE_PROVIDER'
   )),
  'identical release replay must not restore capacity twice'
);

set role service_role;
create temporary table unclaimed_encounter_compute as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1',
  'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER', '00000000-0000-0000-0000-0000000008a2',
  'test-provider', null, 'small-text', 'test-small', 'OWNER', 'USD', 'test/1',
  100, 200, 25, 'encounter/0.1.0', 1, 1, 'memory/1', 'safety/1', 'router/1',
  'trace-unclaimed-start', 1, null, repeat('9', 64), repeat('a', 64)
);
reset role;
set role service_role;
do $$
begin
  begin
    perform companion_private.start_compute_transaction(
      '00000000-0000-0000-0000-0000000001b1',
      (select transaction_id from unclaimed_encounter_compute)
    );
    raise exception 'unclaimed social Encounter provider start unexpectedly succeeded';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'social Encounter provider start requires a durable execution claim' then
      raise;
    end if;
  end;
end;
$$;
reset role;
select public.test_assert(
  (select entry_type = 'RESERVATION' and status = 'RESERVED'
   from public.compute_ledger_entries
   where transaction_id = (select transaction_id from unclaimed_encounter_compute)
   order by sequence desc limit 1),
  'rejected unclaimed provider start must append no START fact'
);
set role service_role;
select companion_private.release_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from unclaimed_encounter_compute),
  'UNCLAIMED_START_TEST_CLEANUP'
);
reset role;

insert into public.publication_budgets (
  id, owner_id, companion_id, period_start, period_end, max_publications
) values (
  '00000000-0000-0000-0000-0000000013b1',
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  now() - interval '1 hour', now() + interval '1 hour', 1
);

insert into public.encounter_invitations (
  id, initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
  approved_by_owner_ids, purpose, expires_at
) values (
  '00000000-0000-0000-0000-0000000008c1',
  '00000000-0000-0000-0000-0000000001a1',
  '00000000-0000-0000-0000-0000000005a1',
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000005b1',
  array['00000000-0000-0000-0000-0000000001a1'::uuid, '00000000-0000-0000-0000-0000000001b1'::uuid],
  'Atomic delivery integration test', now() + interval '1 day'
);

set role service_role;
create temporary table atomic_publication_reservation as
select * from companion_private.reserve_publication(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000008e1',
  repeat('5', 64), repeat('6', 64)
);
create temporary table delivery_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1',
  'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER', '00000000-0000-0000-0000-0000000008e1',
  'test-provider', null, 'small-text', 'test-small', 'OWNER', 'USD', 'test/1',
  100, 200, 25, 'encounter/0.1.0', 1, 1, 'memory/1', 'safety/1', 'router/1',
  'trace-atomic-delivery', 1, null, repeat('7', 64), repeat('8', 64)
);
reset role;
set role service_role;
do $$
begin
  begin
    perform companion_private.claim_encounter_execution(
      '00000000-0000-0000-0000-0000000001c1', repeat('1', 64), repeat('2', 64),
      '00000000-0000-0000-0000-0000000008e1',
      '00000000-0000-0000-0000-0000000008c1',
      (select transaction_id from delivery_compute_reservation),
      (select reservation_id from atomic_publication_reservation)
    );
    raise exception 'cross-Owner execution claim unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Encounter invitation not found for initiating Owner' then
      raise;
    end if;
  end;
end;
$$;
reset role;
select public.test_assert(
  (select claimed_at is null from public.encounter_invitations
   where id = '00000000-0000-0000-0000-0000000008c1'),
  'cross-Owner execution claim must leave the invitation untouched'
);
set role service_role;
create temporary table delivery_execution_claim as
select * from companion_private.claim_encounter_execution(
  '00000000-0000-0000-0000-0000000001a1', repeat('1', 64), repeat('2', 64),
  '00000000-0000-0000-0000-0000000008e1',
  '00000000-0000-0000-0000-0000000008c1',
  (select transaction_id from delivery_compute_reservation),
  (select reservation_id from atomic_publication_reservation)
);
reset role;
select public.test_assert(
  (select not replayed from delivery_execution_claim),
  'first Encounter execution claim must atomically succeed'
);
select public.test_assert(
  (select claimed_at is not null and used_at is null
   from public.encounter_invitations where id = '00000000-0000-0000-0000-0000000008c1'),
  'execution claim must close invitation reuse before provider start'
);
select public.test_assert(
  (select entry_type = 'RESERVATION' and status = 'RESERVED'
   from public.compute_ledger_entries
   where transaction_id = (select transaction_id from delivery_compute_reservation)
   order by sequence desc limit 1),
  'Encounter execution claim must occur before provider START'
);
select public.test_assert(
  (select replayed from companion_private.claim_encounter_execution(
    '00000000-0000-0000-0000-0000000001a1', repeat('1', 64), repeat('2', 64),
    '00000000-0000-0000-0000-0000000008e1',
    '00000000-0000-0000-0000-0000000008c1',
    (select transaction_id from delivery_compute_reservation),
    (select reservation_id from atomic_publication_reservation)
  )),
  'identical execution claim retry must return the original durable claim'
);
do $$
begin
  begin
    perform companion_private.claim_encounter_execution(
      '00000000-0000-0000-0000-0000000001a1', repeat('1', 64), repeat('3', 64),
      '00000000-0000-0000-0000-0000000008e1',
      '00000000-0000-0000-0000-0000000008c1',
      (select transaction_id from delivery_compute_reservation),
      (select reservation_id from atomic_publication_reservation)
    );
    raise exception 'execution claim idempotency substitution unexpectedly succeeded';
  exception when unique_violation then
    null;
  end;
end;
$$;
set role service_role;
select companion_private.start_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from delivery_compute_reservation)
);
select companion_private.settle_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from delivery_compute_reservation),
  80, 120, 20, 'SUCCEEDED', 'DELIVERED', repeat('a', 64)
);
reset role;

insert into companion_private.encounter_safety_events (
  id, owner_id, companion_id, social_twin_id, direction, surface, threat_types, decision,
  content_hash, sanitized_content_hash, redaction_count, policy_version, related_encounter_id
) values (
  '00000000-0000-0000-0000-0000000007c1',
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1',
  'OUTPUT', 'ENCOUNTER', '{}', 'ALLOW', repeat('8', 64), repeat('9', 64), 0,
  'safety/1', '00000000-0000-0000-0000-0000000008e1'
);

select public.test_assert(
  (select decision = 'RESERVED' and not replayed from atomic_publication_reservation),
  'publication reservation must atomically succeed before delivery'
);
select public.test_assert(
  (select reserved_publications = 1 and consumed_publications = 0
   from public.publication_budgets where id = '00000000-0000-0000-0000-0000000013b1'),
  'publication reservation must hold independent capacity'
);

set role service_role;
create temporary table delivered_encounter as
select * from companion_private.persist_delivered_encounter(
  '00000000-0000-0000-0000-0000000001a1',
  repeat('b', 64), repeat('c', 64),
  '00000000-0000-0000-0000-0000000008e1',
  '00000000-0000-0000-0000-0000000008c1',
  (select reservation_id from atomic_publication_reservation),
  'DLP-cleared atomic artifact', repeat('9', 64), 'DELIVERED',
  (select transaction_id from delivery_compute_reservation),
  '00000000-0000-0000-0000-0000000007c1', now()
);
reset role;
grant select on delivery_compute_reservation to authenticated;

select public.test_assert(
  (select result_status = 'DELIVERED' and not replayed from delivered_encounter),
  'atomic Encounter delivery must succeed exactly once'
);
select public.test_assert(
  (select used_at is not null from public.encounter_invitations
   where id = '00000000-0000-0000-0000-0000000008c1'),
  'successful delivery must consume the one-shot invitation'
);
select public.test_assert(
  (select execution_claim_id = (select execution_claim_id from delivery_execution_claim)
   from companion_private.encounter_idempotency
   where encounter_id = '00000000-0000-0000-0000-0000000008e1'),
  'successful delivery must bind its durable result to the pre-provider claim'
);
select public.test_assert(
  (select count(*) = 1 from public.encounter_artifacts
   where id = (select artifact_id from delivered_encounter)
     and body = 'DLP-cleared atomic artifact'),
  'successful delivery must persist only the safety-authorized Artifact'
);
select public.test_assert(
  (select count(*) = 2 from public.life_events
   where id in (
     (select initiator_life_event_id from delivered_encounter),
     (select responder_life_event_id from delivered_encounter)
   ) and visibility_domain = 'OWNER_ONLY'),
  'successful delivery must persist one Owner-only Life Event per participant'
);
select public.test_assert(
  (select count(*) = 2 from public.life_event_inbox
   where life_event_id in (
     (select initiator_life_event_id from delivered_encounter),
     (select responder_life_event_id from delivered_encounter)
   )),
  'Life Events and Inbox rows must commit in the same transaction'
);
select public.test_assert(
  (select reserved_publications = 0 and consumed_publications = 1
   from public.publication_budgets where id = '00000000-0000-0000-0000-0000000013b1'),
  'atomic delivery must consume, not merely release, publication capacity'
);

select public.test_assert(
  (select replayed and artifact_id = (select artifact_id from delivered_encounter)
   from companion_private.persist_delivered_encounter(
     '00000000-0000-0000-0000-0000000001a1',
     repeat('b', 64), repeat('c', 64),
     '00000000-0000-0000-0000-0000000008e1',
     '00000000-0000-0000-0000-0000000008c1',
     (select reservation_id from atomic_publication_reservation),
     'DLP-cleared atomic artifact', repeat('9', 64), 'DELIVERED',
     (select transaction_id from delivery_compute_reservation),
     '00000000-0000-0000-0000-0000000007c1', now()
   )),
  'identical Encounter replay must return the durable result without duplicate writes'
);
select public.test_assert(
  (select count(*) = 1 from public.encounter_artifacts
   where invitation_id = '00000000-0000-0000-0000-0000000008c1'),
  'idempotent Encounter replay must not duplicate the Artifact'
);

do $$
begin
  begin
    perform companion_private.persist_delivered_encounter(
      '00000000-0000-0000-0000-0000000001a1',
      repeat('b', 64), repeat('d', 64),
      '00000000-0000-0000-0000-0000000008e1',
      '00000000-0000-0000-0000-0000000008c1',
      (select reservation_id from atomic_publication_reservation),
      'substituted body', repeat('9', 64), 'DELIVERED',
      (select transaction_id from delivery_compute_reservation),
      '00000000-0000-0000-0000-0000000007c1', now()
    );
    raise exception 'Encounter idempotency substitution unexpectedly succeeded';
  exception when unique_violation then
    null;
  end;
end;
$$;

create temporary table rejected_publication_reservation as
select * from companion_private.reserve_publication(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000008f1',
  repeat('d', 64), repeat('e', 64)
);
select public.test_assert(
  (select decision = 'REJECTED' and outcome_code = 'PUBLICATION_BUDGET_EXHAUSTED'
   from rejected_publication_reservation),
  'publication hard-cap exhaustion must fail closed with durable attribution'
);
select public.test_assert(
  (select reserved_publications = 0 and consumed_publications = 1
   from public.publication_budgets where id = '00000000-0000-0000-0000-0000000013b1'),
  'rejected publication must not alter budget counters'
);

-- A pre-provider input block is durable and idempotent, but preserves the invitation.
insert into public.encounter_invitations (
  id, initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
  approved_by_owner_ids, purpose, expires_at
) values (
  '00000000-0000-0000-0000-0000000008d1',
  '00000000-0000-0000-0000-0000000001a1',
  '00000000-0000-0000-0000-0000000005a1',
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000005b1',
  array['00000000-0000-0000-0000-0000000001a1'::uuid, '00000000-0000-0000-0000-0000000001b1'::uuid],
  'Input block integration test', now() + interval '1 day'
);
insert into companion_private.encounter_safety_events (
  id, owner_id, companion_id, social_twin_id, direction, surface, threat_types, decision,
  content_hash, redaction_count, policy_version, related_encounter_id
) values (
  '00000000-0000-0000-0000-0000000007d1',
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1',
  'INPUT', 'ENCOUNTER', array['PROMPT_INJECTION'], 'BLOCK', repeat('1', 64), 0,
  'safety/1', '00000000-0000-0000-0000-0000000008e2'
);

do $$
begin
  begin
    perform companion_private.persist_encounter_non_delivery(
      '00000000-0000-0000-0000-0000000001c1', repeat('2', 64), repeat('3', 64),
      '00000000-0000-0000-0000-0000000008e2',
      '00000000-0000-0000-0000-0000000008d1',
      'BLOCKED', 'INPUT_SAFETY_BLOCK', null, null,
      '00000000-0000-0000-0000-0000000007d1', now()
    );
    raise exception 'cross-Owner non-delivery persistence unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Encounter invitation not found for initiating Owner' then
      raise;
    end if;
  end;
end;
$$;
select public.test_assert(
  (select count(*) = 0 from companion_private.encounter_idempotency
   where owner_id = '00000000-0000-0000-0000-0000000001c1'),
  'cross-Owner rejection must persist no idempotency result'
);

set role service_role;
create temporary table blocked_before_provider as
select * from companion_private.persist_encounter_non_delivery(
  '00000000-0000-0000-0000-0000000001a1', repeat('2', 64), repeat('3', 64),
  '00000000-0000-0000-0000-0000000008e2',
  '00000000-0000-0000-0000-0000000008d1',
  'BLOCKED', 'INPUT_SAFETY_BLOCK', null, null,
  '00000000-0000-0000-0000-0000000007d1', now()
);
reset role;

select public.test_assert(
  (select result_status = 'BLOCKED' and not invitation_consumed
     and not publication_released and not replayed from blocked_before_provider),
  'input safety block must persist without consuming capability or budget'
);
select public.test_assert(
  (select used_at is null from public.encounter_invitations
   where id = '00000000-0000-0000-0000-0000000008d1'),
  'pre-provider block must preserve the one-shot invitation'
);
select public.test_assert(
  (select replayed and not invitation_consumed
   from companion_private.persist_encounter_non_delivery(
     '00000000-0000-0000-0000-0000000001a1', repeat('2', 64), repeat('3', 64),
     '00000000-0000-0000-0000-0000000008e2',
     '00000000-0000-0000-0000-0000000008d1',
     'BLOCKED', 'INPUT_SAFETY_BLOCK', null, null,
     '00000000-0000-0000-0000-0000000007d1', now()
   )),
  'identical input-block replay must return its durable non-delivery result'
);

do $$
begin
  begin
    perform companion_private.persist_encounter_non_delivery(
      '00000000-0000-0000-0000-0000000001a1', repeat('2', 64), repeat('4', 64),
      '00000000-0000-0000-0000-0000000008e2',
      '00000000-0000-0000-0000-0000000008d1',
      'BLOCKED', 'INPUT_SAFETY_BLOCK', null, null,
      '00000000-0000-0000-0000-0000000007d1', now()
    );
    raise exception 'non-delivery idempotency substitution unexpectedly succeeded';
  exception when unique_violation then
    null;
  end;
end;
$$;

-- Provider-started terminal outcomes consume the invitation and release publication atomically.
update public.compute_budgets
set max_model_calls = 3
where id = '00000000-0000-0000-0000-0000000012b1';
update public.publication_budgets
set max_publications = 3
where id = '00000000-0000-0000-0000-0000000013b1';

insert into public.encounter_invitations (
  id, initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
  approved_by_owner_ids, purpose, expires_at
) values
  (
    '00000000-0000-0000-0000-0000000008d2',
    '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1',
    '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000005b1',
    array['00000000-0000-0000-0000-0000000001a1'::uuid, '00000000-0000-0000-0000-0000000001b1'::uuid],
    'Output block integration test', now() + interval '1 day'
  ),
  (
    '00000000-0000-0000-0000-0000000008d3',
    '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1',
    '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000005b1',
    array['00000000-0000-0000-0000-0000000001a1'::uuid, '00000000-0000-0000-0000-0000000001b1'::uuid],
    'Provider failure integration test', now() + interval '1 day'
  );

set role service_role;
create temporary table blocked_publication_reservation as
select * from companion_private.reserve_publication(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000008e3', repeat('4', 64), repeat('5', 64)
);
create temporary table blocked_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1',
  'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER', '00000000-0000-0000-0000-0000000008e3',
  'test-provider', null, 'small-text', 'test-small', 'OWNER', 'USD', 'test/1',
  100, 200, 25, 'encounter/0.1.0', 1, 1, 'memory/1', 'safety/1', 'router/1',
  'trace-output-block', 1, null, repeat('6', 64), repeat('7', 64)
);
create temporary table blocked_execution_claim as
select * from companion_private.claim_encounter_execution(
  '00000000-0000-0000-0000-0000000001a1', repeat('4', 64), repeat('5', 64),
  '00000000-0000-0000-0000-0000000008e3',
  '00000000-0000-0000-0000-0000000008d2',
  (select transaction_id from blocked_compute_reservation),
  (select reservation_id from blocked_publication_reservation)
);
select companion_private.start_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from blocked_compute_reservation)
);
select companion_private.settle_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from blocked_compute_reservation),
  75, 100, 15, 'BLOCKED', 'OUTPUT_SAFETY_BLOCK', repeat('8', 64)
);
reset role;

insert into companion_private.encounter_safety_events (
  id, owner_id, companion_id, social_twin_id, direction, surface, threat_types, decision,
  content_hash, redaction_count, policy_version, related_encounter_id
) values (
  '00000000-0000-0000-0000-0000000007d2',
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1',
  'OUTPUT', 'ENCOUNTER', array['CREDENTIAL'], 'BLOCK', repeat('9', 64), 0,
  'safety/1', '00000000-0000-0000-0000-0000000008e3'
);

do $$
begin
  begin
    perform companion_private.persist_encounter_non_delivery(
      '00000000-0000-0000-0000-0000000001a1', repeat('a', 64), repeat('b', 64),
      '00000000-0000-0000-0000-0000000008e3',
      '00000000-0000-0000-0000-0000000008d2',
      'BLOCKED', 'OUTPUT_SAFETY_BLOCK',
      (select transaction_id from blocked_compute_reservation),
      (select reservation_id from blocked_publication_reservation),
      '00000000-0000-0000-0000-0000000007c1', now()
    );
    raise exception 'mismatched output safety evidence unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;
select public.test_assert(
  (select used_at is null from public.encounter_invitations
   where id = '00000000-0000-0000-0000-0000000008d2'),
  'rejected safety evidence must roll back invitation consumption'
);
select public.test_assert(
  (select status = 'RESERVED' from public.publication_reservations
   where id = (select reservation_id from blocked_publication_reservation)),
  'rejected safety evidence must preserve the publication hold'
);

set role service_role;
create temporary table blocked_after_provider as
select * from companion_private.persist_encounter_non_delivery(
  '00000000-0000-0000-0000-0000000001a1', repeat('a', 64), repeat('b', 64),
  '00000000-0000-0000-0000-0000000008e3',
  '00000000-0000-0000-0000-0000000008d2',
  'BLOCKED', 'OUTPUT_SAFETY_BLOCK',
  (select transaction_id from blocked_compute_reservation),
  (select reservation_id from blocked_publication_reservation),
  '00000000-0000-0000-0000-0000000007d2', now()
);
reset role;

select public.test_assert(
  (select invitation_consumed and publication_released and not replayed from blocked_after_provider),
  'output block must atomically consume the invitation and release publication'
);
select public.test_assert(
  (select execution_claim_id = (select execution_claim_id from blocked_execution_claim)
   from companion_private.encounter_idempotency
   where encounter_id = '00000000-0000-0000-0000-0000000008e3'),
  'output block must bind its non-delivery result to the pre-provider claim'
);
select public.test_assert(
  (select status = 'RELEASED' from public.publication_reservations
   where id = (select reservation_id from blocked_publication_reservation)),
  'output block must durably release its publication reservation'
);
select public.test_assert(
  (select count(*) = 0 from public.encounter_artifacts
   where invitation_id = '00000000-0000-0000-0000-0000000008d2'),
  'output block must never create an Artifact'
);
select public.test_assert(
  (select count(*) = 0 from public.life_events
   where decision_transaction_id = (select transaction_id from blocked_compute_reservation)),
  'output block must never create a Life Event'
);

set role service_role;
create temporary table failed_publication_reservation as
select * from companion_private.reserve_publication(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000008e4', repeat('c', 64), repeat('d', 64)
);
create temporary table failed_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1',
  'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER', '00000000-0000-0000-0000-0000000008e4',
  'test-provider', null, 'small-text', 'test-small', 'OWNER', 'USD', 'test/1',
  100, 200, 25, 'encounter/0.1.0', 1, 1, 'memory/1', 'safety/1', 'router/1',
  'trace-provider-failure', 1, null, repeat('e', 64), repeat('f', 64)
);
create temporary table failed_execution_claim as
select * from companion_private.claim_encounter_execution(
  '00000000-0000-0000-0000-0000000001a1', repeat('6', 64), repeat('7', 64),
  '00000000-0000-0000-0000-0000000008e4',
  '00000000-0000-0000-0000-0000000008d3',
  (select transaction_id from failed_compute_reservation),
  (select reservation_id from failed_publication_reservation)
);
select companion_private.start_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from failed_compute_reservation)
);
select companion_private.settle_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from failed_compute_reservation),
  50, 0, 10, 'FAILED', 'PROVIDER_ERROR', null
);
create temporary table failed_after_provider as
select * from companion_private.persist_encounter_non_delivery(
  '00000000-0000-0000-0000-0000000001a1', repeat('0', 64), repeat('1', 64),
  '00000000-0000-0000-0000-0000000008e4',
  '00000000-0000-0000-0000-0000000008d3',
  'FAILED', 'PROVIDER_ERROR',
  (select transaction_id from failed_compute_reservation),
  (select reservation_id from failed_publication_reservation), null, now()
);
reset role;

select public.test_assert(
  (select result_status = 'FAILED' and invitation_consumed and publication_released
     and not replayed from failed_after_provider),
  'provider failure must persist as terminal non-delivery and release publication'
);
select public.test_assert(
  (select execution_claim_id = (select execution_claim_id from failed_execution_claim)
   from companion_private.encounter_idempotency
   where encounter_id = '00000000-0000-0000-0000-0000000008e4'),
  'provider failure must bind its non-delivery result to the pre-provider claim'
);
select public.test_assert(
  (select count(*) = 0 from public.encounter_artifacts
   where invitation_id = '00000000-0000-0000-0000-0000000008d3'),
  'provider failure must never create an Artifact'
);
select public.test_assert(
  (select reserved_publications = 0 and consumed_publications = 1
   from public.publication_budgets where id = '00000000-0000-0000-0000-0000000013b1'),
  'blocked and failed outcomes must release holds without consuming publication budget'
);

-- A stale claim with no START is terminalized without charge or delivery. A START is never guessed away.
update public.compute_budgets
set max_model_calls = 5
where id = '00000000-0000-0000-0000-0000000012b1';
update public.publication_budgets
set max_publications = 5
where id = '00000000-0000-0000-0000-0000000013b1';

insert into public.encounter_invitations (
  id, initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
  approved_by_owner_ids, purpose, expires_at
) values
  (
    '00000000-0000-0000-0000-0000000008d4',
    '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1',
    '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000005b1',
    array['00000000-0000-0000-0000-0000000001a1'::uuid, '00000000-0000-0000-0000-0000000001b1'::uuid],
    'Stale unstarted recovery integration test', clock_timestamp() + interval '5 seconds'
  ),
  (
    '00000000-0000-0000-0000-0000000008d5',
    '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1',
    '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000005b1',
    array['00000000-0000-0000-0000-0000000001a1'::uuid, '00000000-0000-0000-0000-0000000001b1'::uuid],
    'Started recovery rejection integration test', clock_timestamp() + interval '5 seconds'
  );

set role service_role;
create temporary table stale_publication_reservation as
select * from companion_private.reserve_publication(
  '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000008e5', repeat('12', 32), repeat('13', 32)
);
create temporary table stale_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1', 'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER',
  '00000000-0000-0000-0000-0000000008e5', 'test-provider', null, 'small-text', 'test-small',
  'OWNER', 'USD', 'test/1', 100, 200, 25, 'encounter/0.1.0', 1, 1,
  'memory/1', 'safety/1', 'router/1', 'trace-stale-unstarted', 1, null, repeat('14', 32), repeat('15', 32)
);
create temporary table stale_execution_claim as
select * from companion_private.claim_encounter_execution(
  '00000000-0000-0000-0000-0000000001a1', repeat('16', 32), repeat('17', 32),
  '00000000-0000-0000-0000-0000000008e5', '00000000-0000-0000-0000-0000000008d4',
  (select transaction_id from stale_compute_reservation),
  (select reservation_id from stale_publication_reservation)
);

create temporary table started_publication_reservation as
select * from companion_private.reserve_publication(
  '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000008e6', repeat('18', 32), repeat('19', 32)
);
create temporary table started_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1', 'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER',
  '00000000-0000-0000-0000-0000000008e6', 'test-provider', null, 'small-text', 'test-small',
  'OWNER', 'USD', 'test/1', 100, 200, 25, 'encounter/0.1.0', 1, 1,
  'memory/1', 'safety/1', 'router/1', 'trace-started-recovery', 1, null, repeat('1a', 32), repeat('1b', 32)
);
create temporary table started_execution_claim as
select * from companion_private.claim_encounter_execution(
  '00000000-0000-0000-0000-0000000001a1', repeat('1c', 32), repeat('1d', 32),
  '00000000-0000-0000-0000-0000000008e6', '00000000-0000-0000-0000-0000000008d5',
  (select transaction_id from started_compute_reservation),
  (select reservation_id from started_publication_reservation)
);
select companion_private.start_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1', (select transaction_id from started_compute_reservation)
);

do $$
begin
  begin
    perform companion_private.recover_stale_unstarted_encounter(
      '00000000-0000-0000-0000-0000000001a1',
      (select execution_claim_id from stale_execution_claim)
    );
    raise exception 'fresh execution claim unexpectedly recovered';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'Encounter execution claim is not stale' then
      raise;
    end if;
  end;
end;
$$;
select pg_sleep(5.1);

create temporary table recovered_stale_encounter as
select * from companion_private.recover_stale_unstarted_encounter(
  '00000000-0000-0000-0000-0000000001a1',
  (select execution_claim_id from stale_execution_claim)
);
reset role;

select public.test_assert(
  (select result_status = 'FAILED' and invitation_consumed and compute_released
     and publication_released and not replayed from recovered_stale_encounter),
  'stale unstarted recovery must atomically terminalize every reservation'
);
select public.test_assert(
  (select used_at is not null from public.encounter_invitations
   where id = '00000000-0000-0000-0000-0000000008d4'),
  'stale recovery must consume rather than reopen the one-shot invitation'
);
select public.test_assert(
  (select execution_claim_id = (select execution_claim_id from stale_execution_claim)
     and result_status = 'FAILED' and outcome_code = 'STALE_CLAIM_RECOVERED_BEFORE_PROVIDER'
   from companion_private.encounter_idempotency
   where encounter_id = '00000000-0000-0000-0000-0000000008e5'),
  'stale recovery must bind a durable non-delivery result to the original claim'
);
select public.test_assert(
  (select count(*) = 0 from public.encounter_artifacts
   where invitation_id = '00000000-0000-0000-0000-0000000008d4'),
  'stale recovery must create no Artifact'
);
select public.test_assert(
  (select count(*) = 0 from public.life_events
   where decision_transaction_id = (select transaction_id from stale_compute_reservation)),
  'stale recovery must create no Life Event'
);

set role service_role;
select public.test_assert(
  (select replayed from companion_private.recover_stale_unstarted_encounter(
    '00000000-0000-0000-0000-0000000001a1',
    (select execution_claim_id from stale_execution_claim)
  )),
  'identical stale recovery must replay without restoring capacity twice'
);
do $$
begin
  begin
    perform companion_private.recover_stale_unstarted_encounter(
      '00000000-0000-0000-0000-0000000001a1',
      (select execution_claim_id from started_execution_claim)
    );
    raise exception 'started execution was incorrectly released as unstarted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'started Encounter execution requires provider reconciliation, not pre-provider recovery' then
      raise;
    end if;
  end;
end;
$$;
select companion_private.settle_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1', (select transaction_id from started_compute_reservation),
  0, 0, 25, 'FAILED', 'RECOVERY_TEST_PROVIDER_UNKNOWN', null
);
select companion_private.persist_encounter_non_delivery(
  '00000000-0000-0000-0000-0000000001a1', repeat('1e', 32), repeat('1f', 32),
  '00000000-0000-0000-0000-0000000008e6', '00000000-0000-0000-0000-0000000008d5',
  'FAILED', 'RECOVERY_TEST_PROVIDER_UNKNOWN', (select transaction_id from started_compute_reservation),
  (select reservation_id from started_publication_reservation), null, clock_timestamp()
);
reset role;

select public.test_assert(
  (select reserved_calls = 0 and settled_calls = 4
   from public.compute_budgets where id = '00000000-0000-0000-0000-0000000012b1'),
  'unstarted recovery must release while started recovery remains conservatively settled'
);
select public.test_assert(
  (select reserved_publications = 0 and consumed_publications = 1
   from public.publication_budgets where id = '00000000-0000-0000-0000-0000000013b1'),
  'recovery paths must release publication holds without consuming delivery budget'
);

-- A stale provider START is conservatively charged and terminalized without delivery.
update public.compute_budgets
set max_model_calls = 10
where id = '00000000-0000-0000-0000-0000000012b1';
update public.publication_budgets
set max_publications = 10
where id = '00000000-0000-0000-0000-0000000013b1';

insert into public.encounter_invitations (
  id, initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
  approved_by_owner_ids, purpose, expires_at
) values (
  '00000000-0000-0000-0000-0000000008d6',
  '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1',
  '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000005b1',
  array['00000000-0000-0000-0000-0000000001a1'::uuid, '00000000-0000-0000-0000-0000000001b1'::uuid],
  'Started provider reconciliation integration test', clock_timestamp() + interval '1 second'
);

set role service_role;
create temporary table reconciliation_publication_reservation as
select * from companion_private.reserve_publication(
  '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000008e7', repeat('20', 32), repeat('21', 32)
);
create temporary table reconciliation_compute_reservation as
select * from companion_private.reserve_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1',
  '00000000-0000-0000-0000-0000000005b1', 'SOCIAL_ENCOUNTER_RESPONSE', 'ENCOUNTER',
  '00000000-0000-0000-0000-0000000008e7', 'test-provider', null, 'small-text', 'test-small',
  'OWNER', 'USD', 'test/1', 100, 200, 25, 'encounter/0.1.0', 1, 1,
  'memory/1', 'safety/1', 'router/1', 'trace-started-reconciliation', 1, null,
  repeat('22', 32), repeat('23', 32)
);
create temporary table reconciliation_execution_claim as
select * from companion_private.claim_encounter_execution(
  '00000000-0000-0000-0000-0000000001a1', repeat('24', 32), repeat('25', 32),
  '00000000-0000-0000-0000-0000000008e7', '00000000-0000-0000-0000-0000000008d6',
  (select transaction_id from reconciliation_compute_reservation),
  (select reservation_id from reconciliation_publication_reservation)
);
select companion_private.start_compute_transaction(
  '00000000-0000-0000-0000-0000000001b1',
  (select transaction_id from reconciliation_compute_reservation)
);

do $$
begin
  begin
    perform companion_private.reconcile_stale_started_encounter(
      '00000000-0000-0000-0000-0000000001c1',
      (select execution_claim_id from reconciliation_execution_claim),
      'PROVIDER_TERMINAL_UNAVAILABLE', 'PROVIDER_RECORD_UNAVAILABLE', repeat('26', 32)
    );
    raise exception 'cross-Owner reconciliation unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Encounter execution claim not found for initiating Owner' then raise; end if;
  end;
  begin
    perform companion_private.reconcile_stale_started_encounter(
      '00000000-0000-0000-0000-0000000001a1',
      (select execution_claim_id from reconciliation_execution_claim),
      'PROVIDER_TERMINAL_UNAVAILABLE', 'PROVIDER_RECORD_UNAVAILABLE', repeat('26', 32)
    );
    raise exception 'fresh provider START unexpectedly reconciled';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'started Encounter execution is not stale' then raise; end if;
  end;
end;
$$;

select pg_sleep(1.1);
create temporary table reconciled_started_encounter as
select * from companion_private.reconcile_stale_started_encounter(
  '00000000-0000-0000-0000-0000000001a1',
  (select execution_claim_id from reconciliation_execution_claim),
  'PROVIDER_TERMINAL_UNAVAILABLE', 'PROVIDER_RECORD_UNAVAILABLE', repeat('26', 32)
);
reset role;

select public.test_assert(
  (select result_status = 'FAILED' and outcome_code = 'STARTED_PROVIDER_OUTCOME_UNKNOWN'
     and conservative_cost_minor = 25 and invitation_consumed and publication_released and not replayed
   from reconciled_started_encounter),
  'stale provider START must conservatively terminalize every owned reservation'
);
select public.test_assert(
  (select entry_type = 'RECONCILIATION' and status = 'RECONCILED'
     and input_tokens = 100 and output_tokens = 200 and actual_cost_minor = 25
   from public.compute_ledger_entries
   where id = (select ledger_entry_id from reconciled_started_encounter)),
  'unknown provider usage must charge the full approved reservation ceiling'
);
select public.test_assert(
  (select reason_code = 'PROVIDER_TERMINAL_UNAVAILABLE'
     and evidence_source = 'PROVIDER_RECORD_UNAVAILABLE'
     and provider_request_id_hash = repeat('26', 32)
   from companion_private.provider_call_reconciliations
   where execution_claim_id = (select execution_claim_id from reconciliation_execution_claim)),
  'reconciliation must retain immutable reason, source, hash, time, and ledger linkage'
);
select public.test_assert(
  (select used_at is not null from public.encounter_invitations
   where id = '00000000-0000-0000-0000-0000000008d6'),
  'reconciliation must consume rather than reopen the one-shot invitation'
);
select public.test_assert(
  (select status = 'RELEASED' from public.publication_reservations
   where id = (select reservation_id from reconciliation_publication_reservation)),
  'reconciliation must release publication without consuming it'
);
select public.test_assert(
  (select reserved_calls = 0 and settled_calls = 5
   from public.compute_budgets where id = '00000000-0000-0000-0000-0000000012b1'),
  'reconciliation must settle Compute counters exactly once'
);
select public.test_assert(
  (select outcome = 'RECONCILED' and input_tokens = 100 and output_tokens = 200
     and actual_cost_minor = 25
   from public.get_compute_receipt((select transaction_id from reconciliation_compute_reservation))),
  'Compute Receipt must expose conservative reconciliation instead of zero usage'
);
select public.test_assert(
  (select count(*) = 0 from public.encounter_artifacts
   where invitation_id = '00000000-0000-0000-0000-0000000008d6')
  and (select count(*) = 0 from public.life_events
   where decision_transaction_id = (select transaction_id from reconciliation_compute_reservation)),
  'reconciliation must create no Artifact or Life Event'
);

set role service_role;
select public.test_assert(
  (select replayed and conservative_cost_minor = 25
   from companion_private.reconcile_stale_started_encounter(
     '00000000-0000-0000-0000-0000000001a1',
     (select execution_claim_id from reconciliation_execution_claim),
     'PROVIDER_TERMINAL_UNAVAILABLE', 'PROVIDER_RECORD_UNAVAILABLE', repeat('26', 32)
   )),
  'identical reconciliation must replay without double settlement'
);
do $$
begin
  begin
    perform companion_private.reconcile_stale_started_encounter(
      '00000000-0000-0000-0000-0000000001a1',
      (select execution_claim_id from reconciliation_execution_claim),
      'DIFFERENT_REASON', 'PROVIDER_RECORD_UNAVAILABLE', repeat('26', 32)
    );
    raise exception 'reconciliation evidence substitution unexpectedly succeeded';
  exception when unique_violation then null;
  end;
  begin
    perform companion_private.settle_compute_transaction(
      '00000000-0000-0000-0000-0000000001b1',
      (select transaction_id from reconciliation_compute_reservation),
      1, 1, 1, 'FAILED', 'LATE_PROVIDER_RESULT', repeat('27', 32)
    );
    raise exception 'normal settlement unexpectedly raced past reconciliation';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
reset role;

select public.test_assert(
  not has_function_privilege(
    'authenticated',
    'companion_private.reconcile_stale_started_encounter(uuid,uuid,text,text,text)'::regprocedure,
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'companion_private.reconcile_stale_started_encounter(uuid,uuid,text,text,text)'::regprocedure,
    'EXECUTE'
  ),
  'client roles must not reconcile provider calls'
);
select public.test_assert(
  has_function_privilege(
    'service_role',
    'companion_private.reconcile_stale_started_encounter(uuid,uuid,text,text,text)'::regprocedure,
    'EXECUTE'
  ),
  'service role must retain explicit reconciliation authority'
);
select public.test_assert(
  has_function_privilege(
    'service_role',
    'companion_private.list_stale_started_encounter_candidates(timestamptz,timestamptz,uuid,integer)'::regprocedure,
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'companion_private.list_stale_started_encounter_candidates(timestamptz,timestamptz,uuid,integer)'::regprocedure,
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'companion_private.list_stale_started_encounter_candidates(timestamptz,timestamptz,uuid,integer)'::regprocedure,
    'EXECUTE'
  ),
  'only the server role may scan stale provider starts'
);
select public.test_assert(
  not has_function_privilege(
    'authenticated',
    'companion_private.persist_encounter_non_delivery(uuid,text,text,uuid,uuid,text,text,uuid,uuid,uuid,timestamptz)'::regprocedure,
    'EXECUTE'
  ),
  'authenticated clients must not persist Encounter non-delivery outcomes'
);
select public.test_assert(
  not has_function_privilege(
    'authenticated',
    'companion_private.claim_encounter_execution(uuid,text,text,uuid,uuid,uuid,uuid)'::regprocedure,
    'EXECUTE'
  ),
  'authenticated clients must not claim Encounter executions'
);
select public.test_assert(
  not has_function_privilege(
    'authenticated',
    'companion_private.recover_stale_unstarted_encounter(uuid,uuid)'::regprocedure,
    'EXECUTE'
  ),
  'authenticated clients must not recover stale Encounter executions'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
select public.test_assert(
  (select count(*) = 1 from public.get_compute_receipt(
    (select transaction_id from delivery_compute_reservation)
  ) where owner_id = '00000000-0000-0000-0000-0000000001b1'
      and outcome = 'SUCCEEDED' and actual_cost_minor = 20),
  'Compute Receipt must be derived for the owning authenticated user'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select public.test_assert(
  (select count(*) = 0 from public.get_compute_receipt(
    (select transaction_id from delivery_compute_reservation)
  )),
  'Compute Receipt must fail closed across Owners through RLS'
);
reset role;
select public.test_assert(
  not has_function_privilege(
    'authenticated',
    'companion_private.reserve_publication(uuid,uuid,uuid,text,text)'::regprocedure,
    'EXECUTE'
  ),
  'authenticated clients must not execute publication reservation commands'
);

select public.test_assert(
  has_function_privilege(
    'service_role',
    'companion_private.reserve_compute_transaction(uuid,uuid,uuid,text,text,uuid,text,uuid,text,text,text,text,text,bigint,bigint,bigint,text,integer,integer,text,text,text,text,integer,uuid,text,text)'::regprocedure,
    'EXECUTE'
  ),
  'service role must retain explicit access to backend transaction commands'
);
select public.test_assert(
  not has_function_privilege(
    'authenticated',
    'companion_private.reserve_compute_transaction(uuid,uuid,uuid,text,text,uuid,text,uuid,text,text,text,text,text,bigint,bigint,bigint,text,integer,integer,text,text,text,text,integer,uuid,text,text)'::regprocedure,
    'EXECUTE'
  ),
  'authenticated clients must not cross the service-role transaction boundary'
);

-- Owner-authenticated invitation issuance and dual consent.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1',false);
select * from public.issue_encounter_invitation(
  '00000000-0000-0000-0000-0000000005a1','00000000-0000-0000-0000-0000000005b1',
  '00000000-0000-0000-0000-0000000004a1','00000000-0000-0000-0000-0000000004b1',
  '00000000-0000-0000-0000-0000000003a1','00000000-0000-0000-0000-0000000003b1',
  'Consent contract','ONE_SHOT_ENCOUNTER',repeat('31',32),clock_timestamp()+interval '1 day',repeat('32',32),repeat('33',32)
);
select public.test_assert(
  (select status='PENDING' and approved_by_owner_ids=array['00000000-0000-0000-0000-0000000001a1'::uuid]
   from public.encounter_invitations where context_hash=repeat('31',32)),
  'issuance must record only the initiating Owner approval'
);
do $$ begin
  begin
    perform public.approve_encounter_invitation((select id from public.encounter_invitations where context_hash=repeat('31',32)),repeat('34',32),repeat('35',32));
    raise exception 'issuer unexpectedly supplied responder approval';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    perform companion_private.claim_encounter_execution('00000000-0000-0000-0000-0000000001a1',repeat('36',32),repeat('37',32),gen_random_uuid(),(select id from public.encounter_invitations where context_hash=repeat('31',32)),gen_random_uuid(),gen_random_uuid());
    raise exception 'single-approved invitation unexpectedly became claimable';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role service_role;
do $$ begin begin
  perform companion_private.claim_encounter_execution('00000000-0000-0000-0000-0000000001a1',repeat('36',32),repeat('37',32),gen_random_uuid(),(select id from public.encounter_invitations where context_hash=repeat('31',32)),gen_random_uuid(),gen_random_uuid());
  raise exception 'single-approved invitation unexpectedly became claimable';
exception when insufficient_privilege then null; end; end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1',false);
select * from public.approve_encounter_invitation((select id from public.encounter_invitations where context_hash=repeat('31',32)),repeat('38',32),repeat('39',32));
select public.test_assert((select status='APPROVED' from public.encounter_invitations where context_hash=repeat('31',32)),'responder approval must complete mutual consent');
select public.test_assert((select replayed from public.approve_encounter_invitation((select id from public.encounter_invitations where context_hash=repeat('31',32)),repeat('38',32),repeat('39',32))),'identical approval must replay');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1',false);
select * from public.issue_encounter_invitation('00000000-0000-0000-0000-0000000005a1','00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000004a1','00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000003a1','00000000-0000-0000-0000-0000000003b1','Reject contract','ONE_SHOT_ENCOUNTER',repeat('41',32),clock_timestamp()+interval '1 day',repeat('42',32),repeat('43',32));
do $$ begin begin
  perform public.issue_encounter_invitation('00000000-0000-0000-0000-0000000005a1','00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000004a1','00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000003a1','00000000-0000-0000-0000-0000000003b1','Substituted','ONE_SHOT_ENCOUNTER',repeat('44',32),clock_timestamp()+interval '1 day',repeat('42',32),repeat('45',32));
  raise exception 'issue idempotency substitution unexpectedly succeeded';
exception when unique_violation then null; end; end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1',false);
select * from public.reject_encounter_invitation((select id from public.encounter_invitations where context_hash=repeat('41',32)),repeat('46',32),repeat('47',32));
do $$ begin begin
  perform public.approve_encounter_invitation((select id from public.encounter_invitations where context_hash=repeat('41',32)),repeat('48',32),repeat('49',32));
  raise exception 'rejected invitation unexpectedly approved';
exception when object_not_in_prerequisite_state then null; end; end $$;
select public.test_assert((select replayed from public.reject_encounter_invitation((select id from public.encounter_invitations where context_hash=repeat('41',32)),repeat('46',32),repeat('47',32))),'identical rejection must replay');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1',false);
select * from public.issue_encounter_invitation('00000000-0000-0000-0000-0000000005a1','00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000004a1','00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000003a1','00000000-0000-0000-0000-0000000003b1','Expiry contract','ONE_SHOT_ENCOUNTER',repeat('51',32),clock_timestamp()+interval '100 milliseconds',repeat('52',32),repeat('53',32));
reset role;
select pg_sleep(0.2);
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1',false);
do $$ begin begin
  perform public.approve_encounter_invitation((select id from public.encounter_invitations where context_hash=repeat('51',32)),repeat('54',32),repeat('55',32));
  raise exception 'expired invitation unexpectedly approved';
exception when object_not_in_prerequisite_state then null; end; end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1',false);
select public.test_assert((select count(*)=0 from public.list_encounter_invitations(100,null,null) where context_hash=repeat('31',32)),'unrelated Owner must not list invitation');
do $$ begin begin
  insert into public.encounter_invitations(initiator_owner_id,initiator_twin_id,responder_owner_id,responder_twin_id,approved_by_owner_ids,purpose,expires_at)
  values('00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-0000000005a1','00000000-0000-0000-0000-0000000001b1','00000000-0000-0000-0000-0000000005b1',array['00000000-0000-0000-0000-0000000001a1'::uuid,'00000000-0000-0000-0000-0000000001b1'::uuid],'forbidden',clock_timestamp()+interval '1 day');
  raise exception 'authenticated direct invitation insert unexpectedly succeeded';
exception when insufficient_privilege then null; end; end $$;
reset role;

select public.test_assert(
  not has_function_privilege('service_role','public.issue_encounter_invitation(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text,text)'::regprocedure,'EXECUTE')
  and not has_function_privilege('service_role','public.approve_encounter_invitation(uuid,text,text)'::regprocedure,'EXECUTE'),
  'service role must not impersonate Owner invitation consent'
);

select public.test_assert(
  has_function_privilege('service_role','companion_private.get_encounter_preparation(uuid,uuid)'::regprocedure,'EXECUTE')
  and has_function_privilege('service_role','companion_private.assemble_encounter_context(uuid,uuid,text,text,text,integer)'::regprocedure,'EXECUTE'),
  'service role must execute trusted Encounter context commands'
);
select public.test_assert(
  not has_function_privilege('authenticated','companion_private.get_encounter_preparation(uuid,uuid)'::regprocedure,'EXECUTE')
  and not has_function_privilege('authenticated','companion_private.assemble_encounter_context(uuid,uuid,text,text,text,integer)'::regprocedure,'EXECUTE')
  and not has_table_privilege('authenticated','companion_private.encounter_context_snapshots','SELECT'),
  'authenticated clients must not read or assemble server Encounter context'
);


-- Revalidated World / Life / Profile semantics remain explicit and viewer-scoped.
select public.test_assert(
  not has_table_privilege('authenticated','public.social_feed_items','SELECT')
  and has_function_privilege('authenticated','public.list_world_items(integer,timestamptz)'::regprocedure,'EXECUTE')
  and has_function_privilege('authenticated','public.list_life_continuity(text,uuid,integer,timestamptz,uuid)'::regprocedure,'EXECUTE')
  and has_function_privilege('authenticated','public.get_companion_profile(uuid,text,uuid)'::regprocedure,'EXECUTE'),
  'social feed storage must stay hidden behind viewer-authorized read functions'
);

insert into public.social_feed_items(
  id,kind,author_social_twin_id,author_social_persona_id,published_at,body,source_type,source_id,visibility,status
) values (
  '00000000-0000-0000-0000-00000000f001','ENCOUNTER_EXCERPT',
  '00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000004b1',
  clock_timestamp(),'Public-safe encounter excerpt','ENCOUNTER',
  '00000000-0000-0000-0000-0000000008e1','PUBLIC','PUBLISHED'
);

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1',false);
select public.test_assert(
  (select count(*)=1 from public.list_world_items(20,null)
   where item->>'id'='00000000-0000-0000-0000-00000000f001'
     and item->'author'->>'displayName'='B'
     and (item->'viewerCapabilities'->>'openDetail')::boolean),
  'World must expose the projected public author while retaining participant-only detail capability'
);
select public.test_assert(
  (select payload->'viewer'->>'relationship'='OWNER_OF'
   from public.get_companion_profile('00000000-0000-0000-0000-0000000002a1','OWNER',null)),
  'Owner-view Profile relationship must be server-derived'
);
select public.test_assert(
  (select payload->'viewer'->>'relationship'='SELF'
   from public.get_companion_profile(
     '00000000-0000-0000-0000-0000000002a1','COMPANION','00000000-0000-0000-0000-0000000002a1'
   )),
  'Companion-self Profile relationship must be server-derived'
);
select public.test_assert(
  not exists (
    select 1 from public.list_life_continuity(
      'COMPANION','00000000-0000-0000-0000-0000000002a1',50,null,null
    )
    where item->'companion'->>'companionId'<>'00000000-0000-0000-0000-0000000002a1'
  ),
  'Companion Life must contain only that active Companion continuity'
);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1',false);
select public.test_assert(
  (select count(*)=1 from public.list_world_items(20,null)
   where item->>'id'='00000000-0000-0000-0000-00000000f001'
     and not (item->'viewerCapabilities'->>'openDetail')::boolean),
  'unrelated Owners may see a public World projection but never participant-only Encounter detail'
);
select public.test_assert(
  (select count(*)=0 from public.list_life_continuity('OWNER',null,50,null,null)),
  'unrelated Owner Life must expose no other Owner continuity'
);
reset role;

-- Social Persona projection stays Owner-scoped and cannot be used to activate another Owner's Companion.
select public.test_assert(
  has_function_privilege(
    'authenticated',
    'public.project_and_activate_social_twin(uuid,uuid,text,text,text,jsonb,text,text)'::regprocedure,
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.project_and_activate_social_twin(uuid,uuid,text,text,text,jsonb,text,text)'::regprocedure,
    'EXECUTE'
  ),
  'only authenticated Owner sessions may request Social Persona projection'
);

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1',false);
do $cross_owner$ begin
  begin
    perform public.project_and_activate_social_twin(
      '00000000-0000-0000-0000-0000000002a1',
      '00000000-0000-0000-0000-0000000003a1',
      'not_mine',
      'PRIVATE',
      'QUIET',
      '[{"sourceField":"displayName","targetField":"displayName"}]'::jsonb,
      repeat('61',32),
      repeat('62',32)
    );
    raise exception 'cross-Owner Social Persona projection unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Companion not found for authenticated Owner' then raise; end if;
  end;
end $cross_owner$;
reset role;

drop function public.test_assert(boolean, text);
