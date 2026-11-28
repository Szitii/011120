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
      and (roles @> array['anon']::name[]
        or (roles @> array['authenticated']::name[] and policyname not in ('media_upload', 'media_read', 'media_delete')))
  ),
  'Storage objects must expose no anon policy, and to signed-in users only the three media policies'
);
select public.test_assert(
  (select count(*) = 3 and bool_and(qual like '%bucket_id = ''media''%' or with_check like '%bucket_id = ''media''%')
    from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'media_%')
  and exists(select 1 from storage.buckets where id = 'media' and not public and file_size_limit = 1048576
    and allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[]),
  'the media bucket must be private and bounded, with upload, read and delete policies limited to it'
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

-- A Compute Receipt is derived for the owning Owner only.
grant select on first_compute_reservation to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select public.test_assert(
  (select count(*) = 1 from public.get_compute_receipt(
    (select transaction_id from first_compute_reservation)
  ) where owner_id = '00000000-0000-0000-0000-0000000001a1'
      and outcome = 'SUCCEEDED' and actual_cost_minor = 20),
  'Compute Receipt must be derived for the owning authenticated user'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
select public.test_assert(
  (select count(*) = 0 from public.get_compute_receipt(
    (select transaction_id from first_compute_reservation)
  )),
  'Compute Receipt must fail closed across Owners through RLS'
);
reset role;

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
  '00000000-0000-0000-0000-00000000f001','MOMENT',
  '00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000004b1',
  clock_timestamp(),'Public-safe moment','MOMENT',
  '00000000-0000-0000-0000-0000000008e1','PUBLIC','PUBLISHED'
);

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1',false);
select public.test_assert(
  (select count(*)=1 from public.list_world_items(20,null)
   where item->>'id'='00000000-0000-0000-0000-00000000f001'
     and item->'author'->>'displayName'='B'
     and not (item->'viewerCapabilities'->>'openDetail')::boolean),
  'World must expose the projected public author and no detail capability'
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
  'unrelated Owners may see a public World projection but no detail capability'
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

-- Controls visibility takes effect: PRIVATE hides Owner B's Companion from Owner C at once.
select coalesce((select revision from public.companion_controls where companion_id = '00000000-0000-0000-0000-0000000002b1'), 1) as b_rev \gset
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select public.test_assert((select count(*) = 1 from public.get_companion_profile('00000000-0000-0000-0000-0000000002b1', 'OWNER', null)),
  'a PUBLIC Companion profile is visible to another Owner');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
select public.update_companion_controls('00000000-0000-0000-0000-0000000002b1', :b_rev,
  '{"socialTwinVisibility":"PRIVATE"}'::jsonb, repeat('71', 32), repeat('72', 32));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select public.test_assert((select count(*) = 0 from public.get_companion_profile('00000000-0000-0000-0000-0000000002b1', 'OWNER', null)),
  'Controls PRIVATE must hide the Companion profile from other Owners');
reset role;
select public.test_assert((select p.profile_visibility = 'PRIVATE' and p.supersedes_social_persona_id = '00000000-0000-0000-0000-0000000004b1'
  from public.social_twins t join public.social_personas p on p.id = t.active_social_persona_id
  where t.id = '00000000-0000-0000-0000-0000000005b1'), 'Controls visibility activates a superseding persona copy');

-- Re-projecting cannot lift an operator's suspension.
update public.social_twins set status = 'SUSPENDED' where id = '00000000-0000-0000-0000-0000000005b1';
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
select public.project_and_activate_social_twin('00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000003b1',
  'companion_b', 'PUBLIC', 'QUIET', '[{"sourceField":"displayName","targetField":"displayName"}]'::jsonb, repeat('73', 32), repeat('74', 32));
reset role;
select public.test_assert((select status = 'SUSPENDED' from public.social_twins where id = '00000000-0000-0000-0000-0000000005b1'),
  'an Owner re-projecting must not lift SUSPENDED');
-- Later contract runs use Owner B's original persona.
update public.social_twins set status = 'ACTIVE', active_social_persona_id = '00000000-0000-0000-0000-0000000004b1'
where id = '00000000-0000-0000-0000-0000000005b1';
update public.companion_controls set social_twin_visibility = 'PUBLIC' where companion_id = '00000000-0000-0000-0000-0000000002b1';

-- RPCs that trust the API server's own checks are not callable through Supabase's REST API roles.
select public.test_assert(
  not has_function_privilege('authenticated', 'public.create_companion_import(text,text,integer,text,text,text,jsonb,jsonb,text,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_owner()'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.claim_owner()'::regprocedure, 'EXECUTE'),
  'Import Firewall output and first sign-in must only come through the API server'
);
select public.test_assert(
  has_function_privilege('companion_api', 'public.create_companion_import(text,text,integer,text,text,text,jsonb,jsonb,text,text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.claim_owner()'::regprocedure, 'EXECUTE')
  and pg_has_role('companion_api', 'authenticated', 'USAGE'),
  'the API server role keeps everything authenticated has plus the server-trusted RPCs'
);
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
do $direct_rpc$ begin
  begin
    perform public.create_companion_import('{}', encode(sha256(convert_to('{}','UTF8')), 'hex'), 2, 'forged', 'forged',
      'CHARACTER_CARD_JSON_V2', '{"candidates":[]}'::jsonb, '[]'::jsonb, repeat('e', 64), repeat('f', 64));
    raise exception 'direct client import unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_owner();
    raise exception 'direct client first sign-in unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end $direct_rpc$;
reset role;

-- Chat is private: no client role can touch its tables, and only the API server writes a Companion's words.
select public.test_assert(
  not exists(select 1 from (values ('companion_private.chats'), ('companion_private.chat_members'),
      ('companion_private.chat_messages'), ('companion_private.chat_settings'), ('companion_private.chat_audio')) t(name)
    cross join (values ('anon'), ('authenticated')) r(role)
    where has_table_privilege(r.role, t.name, 'SELECT') or has_table_privilege(r.role, t.name, 'INSERT')
      or has_table_privilege(r.role, t.name, 'UPDATE') or has_table_privilege(r.role, t.name, 'DELETE')),
  'chat tables are reachable only through the chat functions'
);
select public.test_assert(
  not has_function_privilege('authenticated', 'public.chat_claim(uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.chat_finish(uuid,uuid,text,text[],jsonb,text,jsonb)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.chat_send(uuid,text,uuid[],text,jsonb)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.chat_finish(uuid,uuid,text,text[],jsonb,text,jsonb)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.chat_send(uuid,text,uuid[],text,jsonb)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.chat_act(uuid,text,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.chat_act(uuid,text,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.chat_voice_left()'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.chat_voice_left()'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.chat_send_voice(uuid,text,text,jsonb)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.chat_send_voice(uuid,text,text,jsonb)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.chat_audio_get(uuid,uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.chat_audio_get(uuid,uuid)'::regprocedure, 'EXECUTE'),
  'Companion chat replies and their voice can only be written by the API server'
);
-- A Companion writing first and its reminders: queued and delivered by the API server alone; the Owner reads and cancels.
select public.test_assert(
  not has_function_privilege('authenticated', 'public.chat_reach_due(integer,boolean)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.chat_reminder_due(integer,boolean)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.chat_reach_begin(uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.chat_reach_due(integer,boolean)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.chat_reminder_due(integer,boolean)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.chat_reach_begin(uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.chat_reminder_list(uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.chat_reminder_cancel(uuid,uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.chat_reminder_list(uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.chat_reminder_cancel(uuid,uuid)'::regprocedure, 'EXECUTE')
  and not exists(select 1 from (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, 'companion_private.chat_reminders', 'SELECT')
      or has_table_privilege(r.role, 'companion_private.chat_reminders', 'INSERT')
      or has_table_privilege(r.role, 'companion_private.chat_reminders', 'UPDATE')
      or has_table_privilege(r.role, 'companion_private.chat_reminders', 'DELETE')),
  'a Companion''s own turns are queued by the API server alone, and reminders are reachable only through functions'
);
-- Templates and skills: Owners read what is on offer and switch skills; saving an Owner's own skill
-- and reading the wording told to the model are the API server's; editing the catalog is the operators'.
select public.test_assert(
  has_function_privilege('authenticated', 'public.persona_template_list()'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.skill_list(uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.skill_set(uuid,uuid,boolean)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.own_skill_delete(uuid,uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.persona_template_list()'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.own_skill_save(uuid,uuid,text,text,boolean)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.skill_texts(uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.own_skill_save(uuid,uuid,text,text,boolean)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.skill_texts(uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('companion_api', 'companion_admin.skill_set(uuid,text,text,text,integer,boolean,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'companion_admin.kit()'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_admin', 'companion_admin.kit()'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_admin', 'companion_admin.skill_set(uuid,text,text,text,integer,boolean,text)'::regprocedure, 'EXECUTE')
  and not exists(select 1 from (values ('companion_private.persona_templates'), ('companion_private.skills'),
      ('companion_private.companion_skills'), ('companion_private.own_skills'), ('companion_private.world_entries')) t(name)
    cross join (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, t.name, 'SELECT') or has_table_privilege(r.role, t.name, 'INSERT')
      or has_table_privilege(r.role, t.name, 'UPDATE') or has_table_privilege(r.role, t.name, 'DELETE')),
  'templates, skills and the world book are reachable only through functions, each by the role it is for'
);
-- Tools: Owners read the directory and their Companion's connections, disconnect and say no; connecting (the token is
-- sealed first), a turn's secrets, noting calls and everything about making a confirmed call are the API server's;
-- the directory is the operators'.
select public.test_assert(
  has_function_privilege('authenticated', 'public.tool_server_list()'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.companion_tool_list(uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.companion_tool_delete(uuid,uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.tool_request_decline(uuid,uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.tool_server_list()'::regprocedure, 'EXECUTE')
  and not exists(select 1 from (values ('public.companion_tool_save(uuid,uuid,text,text,jsonb)'), ('public.companion_tool_secrets(uuid)'),
      ('public.tool_call_note(uuid,text,text,boolean)'), ('public.tool_request_open(uuid,uuid,uuid,text,jsonb)'),
      ('public.tool_request_take(uuid,uuid)'), ('public.tool_request_finish(uuid,boolean,text)')) f(name)
    where has_function_privilege('authenticated', f.name::regprocedure, 'EXECUTE') or has_function_privilege('anon', f.name::regprocedure, 'EXECUTE')
      or not has_function_privilege('companion_api', f.name::regprocedure, 'EXECUTE'))
  and has_function_privilege('companion_admin', 'companion_admin.tool_servers()'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_admin', 'companion_admin.tool_server_set(uuid,text,text,text,text,text,text[],text[],integer,boolean,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'companion_admin.tool_server_set(uuid,text,text,text,text,text,text[],text[],integer,boolean,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('companion_api', 'companion_admin.tool_server_set(uuid,text,text,text,text,text,text[],text[],integer,boolean,text)'::regprocedure, 'EXECUTE')
  and not exists(select 1 from (values ('companion_private.tool_servers'), ('companion_private.companion_tools'), ('companion_private.tool_requests'),
      ('companion_private.tool_calls')) t(name)
    cross join (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, t.name, 'SELECT') or has_table_privilege(r.role, t.name, 'INSERT')
      or has_table_privilege(r.role, t.name, 'UPDATE') or has_table_privilege(r.role, t.name, 'DELETE')),
  'tools are reachable only through functions, each by the role it is for; an Owner''s sealed token is read by the API server alone'
);
-- Chat pictures: what was seen in one is noted by the API server alone; the table is reachable only through functions.
select public.test_assert(
  has_function_privilege('companion_api', 'public.chat_image_seen(text,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.chat_image_seen(text,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.chat_image_seen(text,text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.media_is_chat(text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.media_chat_unused(text)'::regprocedure, 'EXECUTE')
  and not exists(select 1 from (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, 'companion_private.chat_images', 'SELECT') or has_table_privilege(r.role, 'companion_private.chat_images', 'INSERT')
      or has_table_privilege(r.role, 'companion_private.chat_images', 'UPDATE') or has_table_privilege(r.role, 'companion_private.chat_images', 'DELETE')),
  'chat pictures are described by the API server alone and reachable only through functions'
);
-- Why a reply through the Owner's own key failed is noted by the API server alone.
select public.test_assert(
  has_function_privilege('companion_api', 'public.chat_fail_note(uuid,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.chat_fail_note(uuid,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.chat_fail_note(uuid,text)'::regprocedure, 'EXECUTE'),
  'only the API server notes why an Owner''s own key or agent failed'
);
-- Shared skills: Owners read the shelf, take back and report; handing one in is the API server's
-- (it scans the texts first); deciding about one is the operators'.
select public.test_assert(
  has_function_privilege('authenticated', 'public.shared_skill_list(uuid,text,timestamptz,uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.shared_skill_mine()'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.shared_skill_withdraw(uuid)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.shared_skill_report(uuid,text,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.shared_skill_list(uuid,text,timestamptz,uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.shared_skill_submit(uuid,uuid,text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.shared_skill_submit(uuid,uuid,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'companion_admin.shared_skill_review(uuid,text,text,timestamptz)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('companion_api', 'companion_admin.shared_skill_review(uuid,text,text,timestamptz)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_admin', 'companion_admin.shared_skill_review(uuid,text,text,timestamptz)'::regprocedure, 'EXECUTE')
  and not exists(select 1 from (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, 'companion_private.skill_reports', 'SELECT') or has_table_privilege(r.role, 'companion_private.skill_reports', 'INSERT')
      or has_table_privilege(r.role, 'companion_private.skill_reports', 'UPDATE') or has_table_privilege(r.role, 'companion_private.skill_reports', 'DELETE')),
  'the skill shelf is reachable only through functions, each by the role it is for'
);
-- The export: a signed-in Owner asks for their own copy; the piece that reads a chat's messages by
-- id is nobody's to call.
select public.test_assert(
  has_function_privilege('authenticated', 'public.account_export()'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.account_export()'::regprocedure, 'EXECUTE')
  and not exists(select 1 from (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_function_privilege(r.role, 'companion_private.export_messages(uuid,timestamptz)'::regprocedure, 'EXECUTE')),
  'an Owner exports their own data; a chat''s messages cannot be read by id'
);
select public.test_assert(
  not exists(select 1 from (values ('companion_private.model_switches'), ('companion_private.admin_log'),
      ('companion_private.chat_quota')) t(name)
    cross join (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, t.name, 'SELECT') or has_table_privilege(r.role, t.name, 'INSERT')
      or has_table_privilege(r.role, t.name, 'UPDATE') or has_table_privilege(r.role, t.name, 'DELETE')),
  'model switches, the chat quota and the admin log are reachable only through functions'
);
-- The admin console: its functions are for companion_admin alone, and companion_admin has nothing else.
select public.test_assert(
  exists(select 1 from pg_proc p where p.pronamespace = 'companion_admin'::regnamespace)
  and not exists(select 1 from pg_proc p cross join (values ('anon'), ('authenticated'), ('companion_api'), ('service_role')) r(role)
    where p.pronamespace = 'companion_admin'::regnamespace
      and (has_function_privilege(r.role, p.oid, 'EXECUTE') or has_schema_privilege(r.role, 'companion_admin', 'USAGE')))
  and not exists(select 1 from pg_proc p where p.pronamespace = 'companion_admin'::regnamespace
    and not (has_function_privilege('companion_admin', p.oid, 'EXECUTE') and p.prosecdef
      and p.proconfig @> array['search_path=""'])),
  'admin functions run with a fixed search path and only companion_admin may call them'
);
select public.test_assert(
  not exists(select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'companion_private', 'auth', 'storage') and c.relkind in ('r', 'p', 'v', 'm')
      and (has_table_privilege('companion_admin', c.oid, 'SELECT') or has_table_privilege('companion_admin', c.oid, 'INSERT')
        or has_table_privilege('companion_admin', c.oid, 'UPDATE') or has_table_privilege('companion_admin', c.oid, 'DELETE')))
  and not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'companion_private', 'auth', 'storage')
      and not exists(select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and has_schema_privilege('companion_admin', n.oid, 'USAGE') and has_function_privilege('companion_admin', p.oid, 'EXECUTE'))
  and not exists(select 1 from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'companion_api')
    and pg_has_role('companion_admin', r.oid, 'MEMBER')),
  'companion_admin can read no table and call no function outside its own schema'
);
select public.test_assert(
  exists(select 1 from pg_trigger t where t.tgrelid = 'companion_private.admin_log'::regclass and not t.tgisinternal
    and t.tgfoid = 'companion_private.reject_immutable_mutation()'::regprocedure and (t.tgtype & 8) <> 0 and (t.tgtype & 16) <> 0),
  'the admin log cannot be edited or deleted'
);
select public.test_assert(
  not has_function_privilege('authenticated', 'public.chat_reserve(uuid,uuid,text,text,text,text,bigint,bigint,bigint,text,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.chat_settle(uuid,bigint,bigint,bigint,boolean)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.chat_reserve(uuid,uuid,text,text,text,text,bigint,bigint,bigint,text,text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.chat_settle(uuid,bigint,bigint,bigint,boolean)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.chat_models_enabled(text[],text[])'::regprocedure, 'EXECUTE'),
  'chat model calls are booked and settled only by the API server'
);
select public.test_assert(
  not exists(select 1 from (values ('companion_private.diary_entries'), ('companion_private.diary_settings')) t(name)
    cross join (values ('anon'), ('authenticated'), ('companion_api')) r(role)
    where has_table_privilege(r.role, t.name, 'SELECT') or has_table_privilege(r.role, t.name, 'INSERT')
      or has_table_privilege(r.role, t.name, 'UPDATE') or has_table_privilege(r.role, t.name, 'DELETE'))
  and not has_function_privilege('authenticated', 'public.diary_begin(uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.diary_reserve(uuid,uuid,text,text,text,bigint,bigint,bigint,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.diary_finish(uuid,uuid,text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.diary_finish(uuid,uuid,text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.diary_list(uuid,timestamptz,uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.diary_list(uuid,timestamptz,uuid)'::regprocedure, 'EXECUTE'),
  'diary entries are reachable only through the diary functions, and only the API server writes them'
);

select public.test_assert(
  not exists(select 1 from (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, 'companion_private.feature_switches', 'SELECT')
      or has_table_privilege(r.role, 'companion_private.feature_switches', 'UPDATE'))
  and has_function_privilege('authenticated', 'public.platform_features()'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.platform_features()'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'companion_private.feature_on(text)'::regprocedure, 'EXECUTE')
  and exists(select 1 from pg_trigger where tgrelid = 'companion_private.chats'::regclass and tgname = 'chats_group_create_guard')
  and exists(select 1 from pg_trigger where tgrelid = 'companion_private.chat_messages'::regclass and tgname = 'chat_messages_group_send_guard'),
  'feature switches are read through platform_features and enforced on the chat tables'
);
select public.test_assert(
  companion_private.import_redact('{"candidates":[{"id":"a","approvable":true,"value":"ok"},{"id":"b","approvable":false,"value":"sk-secret"}],"x":1}')
    = '{"candidates":[{"id":"a","approvable":true,"value":"ok"},{"id":"b","approvable":false,"value":null}],"x":1}'::jsonb
  and companion_private.import_redact('{"x":1}') = '{"x":1}'::jsonb,
  'a blocked import candidate keeps no text'
);
select public.test_assert(
  not exists(select 1 from (values ('companion_private.platform_spend_cap'), ('companion_private.wallet_policy'),
      ('companion_private.wallets'), ('companion_private.wallet_entries'), ('companion_private.wallet_holds')) t(name)
    cross join (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, t.name, 'SELECT') or has_table_privilege(r.role, t.name, 'INSERT')
      or has_table_privilege(r.role, t.name, 'UPDATE') or has_table_privilege(r.role, t.name, 'DELETE'))
  and has_function_privilege('authenticated', 'public.wallet_get()'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.wallet_get()'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'companion_private.wallet_hold(uuid,uuid,uuid,bigint,text)'::regprocedure, 'EXECUTE')
  and exists(select 1 from pg_trigger t where t.tgrelid = 'companion_private.wallet_entries'::regclass and not t.tgisinternal
    and t.tgfoid = 'companion_private.reject_immutable_mutation()'::regprocedure),
  'the wallet and the spend cap are reachable only through functions, and the wallet history is append-only'
);
select public.test_assert(
  not exists(select 1 from (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, 'companion_private.agent_keys', 'SELECT') or has_table_privilege(r.role, 'companion_private.agent_keys', 'INSERT')
      or has_table_privilege(r.role, 'companion_private.agent_keys', 'UPDATE') or has_table_privilege(r.role, 'companion_private.agent_keys', 'DELETE'))
  and not has_function_privilege('authenticated', 'public.agent_key_resolve(text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.agent_key_create(uuid,text,text,integer,text[])'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.agent_key_resolve(text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.agent_key_list(uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.agent_key_list(uuid)'::regprocedure, 'EXECUTE'),
  'agent keys are made and resolved only by the API server, and stored only as hashes behind functions'
);
select public.test_assert(
  not exists(select 1 from (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, 'public.community_likes', 'SELECT') or has_table_privilege(r.role, 'public.community_likes', 'INSERT')
      or has_table_privilege(r.role, 'public.community_likes', 'UPDATE') or has_table_privilege(r.role, 'public.community_likes', 'DELETE'))
  and (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.community_likes'::regclass)
  and has_function_privilege('authenticated', 'public.community_like(text,uuid,uuid,boolean)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.community_like(text,uuid,uuid,boolean)'::regprocedure, 'EXECUTE'),
  'likes are reachable only through community_like'
);
select public.test_assert(
  has_function_privilege('authenticated', 'public.companion_delete(uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.companion_delete(uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'companion_private.companion_limit_guard()'::regprocedure, 'EXECUTE')
  and exists(select 1 from pg_trigger where tgrelid = 'public.companions'::regclass and tgname = 'companions_limit_guard'),
  'only a signed-in Owner deletes a Companion, and the limit per Owner is enforced on the table'
);
select public.test_assert(
  has_function_privilege('authenticated', 'public.owner_set_avatar(text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('authenticated', 'public.companion_set_avatar(uuid,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.owner_set_avatar(text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.companion_set_avatar(uuid,text)'::regprocedure, 'EXECUTE')
  and companion_private.avatar_ok(null) and companion_private.avatar_ok('preset:cat_01')
  and not companion_private.avatar_ok('https://example.com/a.png') and not companion_private.avatar_ok('preset:')
  and not companion_private.avatar_ok(E'preset:a\nb'),
  'an avatar is one of the app''s built-in ones, set only by a signed-in Owner'
);
select public.test_assert(
  has_function_privilege('authenticated', 'public.community_publish(text,uuid,uuid,text,text,uuid[],text,text,jsonb)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('anon', 'public.community_publish(text,uuid,uuid,text,text,uuid[],text,text,jsonb)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'companion_private.community_post_visible(uuid,uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'companion_private.community_mentions_json(uuid[],uuid)'::regprocedure, 'EXECUTE')
  and exists(select 1 from pg_trigger where tgrelid = 'public.community_comments'::regclass and tgname = 'community_comments_visible_guard')
  and exists(select 1 from pg_trigger where tgrelid = 'companion_private.agent_drafts'::regclass and tgname = 'agent_drafts_visible_guard'),
  'post visibility is decided by one private rule, and every comment and comment draft is checked against it'
);
select public.test_assert(
  not exists(select 1 from (values ('anon'), ('authenticated'), ('companion_api'), ('companion_admin')) r(role)
    where has_table_privilege(r.role, 'companion_private.agent_runs', 'SELECT') or has_table_privilege(r.role, 'companion_private.agent_runs', 'INSERT')
      or has_table_privilege(r.role, 'companion_private.agent_runs', 'UPDATE') or has_table_privilege(r.role, 'companion_private.agent_runs', 'DELETE'))
  and not has_function_privilege('authenticated', 'public.agent_auto_due(integer,boolean)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.agent_auto_begin(uuid)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.agent_auto_reserve(uuid,uuid,text,text,text,bigint,bigint,bigint,text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.agent_auto_finish(uuid,uuid,text,boolean)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.agent_auto_finish(uuid,uuid,text,boolean)'::regprocedure, 'EXECUTE')
  and has_function_privilege('companion_api', 'public.agent_key_create(uuid,text,text,integer,text[])'::regprocedure, 'EXECUTE'),
  'a Companion''s own posts are started, booked and ended only by the API server'
);

drop function public.test_assert(boolean, text);
