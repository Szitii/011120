begin;

-- Chat step 2: real models answer as Companions.
--
--  * Kill switches, checked before every model call: everything, one provider, or one model.
--    Only a database administrator can change them (backend/scripts/chat-admin.ts); each change
--    is logged. A switched-off call ends the turn as FAILED / DISABLED and charges nothing.
--  * Every call is booked in the existing compute ledger before it starts and settled with the
--    real usage after it (chat_reserve / chat_settle, API server only). Replies use reason
--    OWNER_DIRECT_RESPONSE; the cheap "should I speak?" check uses CHAT_TURN_DECISION.
--  * Each Companion gets a free daily budget (UTC day) the first time it needs one, sized by
--    chat_quota. When it is used up the turn ends as FAILED / QUOTA.
--  * The Owner may pick a model per Companion (chat_settings.model; null = platform default).
--    Which models exist is the API server's catalog, not the database's.

-- ---------- kill switches ----------

create table companion_private.model_switches (
  scope text not null check (scope in ('ALL', 'PROVIDER', 'MODEL')),
  -- ALL: '*'. PROVIDER: the provider id. MODEL: '<provider>/<model>'.
  key text not null check (char_length(key) between 1 and 200),
  enabled boolean not null,
  note text check (note is null or char_length(note) <= 500),
  updated_at timestamptz not null default now(),
  primary key (scope, key),
  check (scope <> 'ALL' or key = '*')
);
create table companion_private.model_switch_log (
  id bigint generated always as identity primary key,
  scope text not null,
  key text not null,
  enabled boolean not null,
  note text,
  changed_by text not null default current_user,
  changed_at timestamptz not null default now()
);

-- Free daily budget per Companion (one row). Changes apply to budgets created from then on.
create table companion_private.chat_quota (
  singleton boolean primary key default true check (singleton),
  daily_calls integer not null check (daily_calls between 0 and 100000),
  daily_cost_minor bigint not null check (daily_cost_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null default now()
);
-- Placeholder until the platform decides: 200 model calls and 1.00 USD per Companion per day.
insert into companion_private.chat_quota(daily_calls, daily_cost_minor, currency) values (200, 100, 'USD');

alter table companion_private.model_switches enable row level security;
alter table companion_private.model_switches force row level security;
alter table companion_private.model_switch_log enable row level security;
alter table companion_private.model_switch_log force row level security;
alter table companion_private.chat_quota enable row level security;
alter table companion_private.chat_quota force row level security;
revoke all on companion_private.model_switches, companion_private.model_switch_log, companion_private.chat_quota
  from public, anon, authenticated;

create function companion_private.model_enabled(p_provider text, p_model text)
returns boolean language sql stable security definer set search_path='' as $$
  select not exists(select 1 from companion_private.model_switches s where not s.enabled
    and (s.scope = 'ALL' or (s.scope = 'PROVIDER' and s.key = p_provider) or (s.scope = 'MODEL' and s.key = p_provider || '/' || p_model)))
$$;

-- Administrator only (no grants): turn platform models on or off.
create function companion_private.admin_set_model_switch(p_scope text, p_key text, p_enabled boolean, p_note text)
returns void language plpgsql security definer set search_path='' as $$
begin
  insert into companion_private.model_switches(scope, key, enabled, note) values (p_scope, p_key, p_enabled, p_note)
    on conflict (scope, key) do update set enabled = excluded.enabled, note = excluded.note, updated_at = now();
  insert into companion_private.model_switch_log(scope, key, enabled, note) values (p_scope, p_key, p_enabled, p_note);
end $$;

-- Administrator only (no grants): the free daily budget for budgets created from now on.
create function companion_private.admin_set_chat_quota(p_daily_calls integer, p_daily_cost_minor bigint)
returns void language sql security definer set search_path='' as $$
  update companion_private.chat_quota set daily_calls = p_daily_calls, daily_cost_minor = p_daily_cost_minor, updated_at = now()
$$;

-- ---------- ledger: a reason for the "should I speak?" check ----------

alter table public.compute_transactions drop constraint compute_transactions_reason_code_check;
alter table public.compute_transactions add constraint compute_transactions_reason_code_check check (reason_code in (
  'IMPORT_IDENTITY_SUMMARY', 'MEMORY_CONSOLIDATION', 'OWNER_DIRECT_RESPONSE', 'SOCIAL_ENCOUNTER_RESPONSE',
  'LIFE_EVENT_EXPRESSION', 'SAFETY_CLASSIFICATION', 'DLP_CLASSIFICATION', 'CHAT_TURN_DECISION'));
insert into companion_private.compute_reason_policies
  (reason_code, billing_party, max_input_tokens, max_output_tokens, max_reserved_cost_minor, public_output, registry_version)
values ('CHAT_TURN_DECISION', 'OWNER', 16000, 100, 50, false, 'compute-reasons/0.2.0');

-- ---------- chat: model choice, ledger link, new failure reasons ----------

alter table companion_private.chat_settings
  add column model text check (model is null or model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$');
-- The ledger transaction of the model call running for this turn, if any.
alter table companion_private.chat_messages add column compute_tx uuid references public.compute_transactions(id);
alter table companion_private.chat_messages drop constraint chat_messages_failure_check;
alter table companion_private.chat_messages add constraint chat_messages_failure_check
  check (failure in ('UNAVAILABLE', 'ERROR', 'DISABLED', 'QUOTA'));

create or replace function companion_private.chat_settings_json(s companion_private.chat_settings)
returns jsonb language sql immutable as $$
  select jsonb_build_object('groupActivity', s.group_activity, 'companionInteraction', s.companion_interaction,
    'model', s.model, 'revision', s.revision)
$$;

drop function public.chat_update_settings(uuid, text, text, integer);
-- Replaces every setting. A stale revision (another device saved first) is a conflict.
-- p_model is checked against the catalog by the API server; null means the platform default.
create function public.chat_update_settings(p_companion uuid, p_group_activity text, p_companion_interaction text,
  p_model text, p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.chat_settings%rowtype; o uuid := companion_private.chat_owner();
begin
  s := companion_private.chat_settings_for(p_companion);
  update companion_private.chat_settings set group_activity = p_group_activity,
    companion_interaction = p_companion_interaction, model = p_model, revision = revision + 1
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='chat settings revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'CHAT_UPDATE_SETTINGS', 'COMPANION', s.companion_id);
  return companion_private.chat_settings_json(s);
end $$;

-- Closes a model call that was never settled (the server stopped mid-call, or the turn is being
-- deleted): it is charged the whole reservation, the safe assumption. No-op for a settled call or
-- none. The transaction is locked before its state is read, so a settlement racing it is seen.
create function companion_private.chat_abandon_compute(p_owner uuid, p_tx uuid)
returns void language plpgsql security definer set search_path='' as $$
declare t public.compute_transactions%rowtype; latest text;
begin
  select * into t from public.compute_transactions where id = p_tx and owner_id = p_owner for update;
  if not found then return; end if;
  select status into latest from public.compute_ledger_entries where transaction_id = p_tx order by sequence desc limit 1;
  if latest = 'STARTED' then
    perform companion_private.settle_compute_transaction(p_owner, p_tx, t.estimated_input_tokens, t.max_output_tokens,
      t.reserved_cost_minor, 'FAILED', 'CHAT_ABANDONED', null);
  elsif latest = 'RESERVED' then
    perform companion_private.release_compute_transaction(p_owner, p_tx, 'CHAT_ABANDONED');
  end if;
end $$;

-- Same as before, plus: a turn taken over from a server that stopped mid-call has its call closed.
create or replace function public.chat_claim(p_chat uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; claim uuid := gen_random_uuid();
  skipped boolean := false;
begin
  c := companion_private.chat_for(p_chat);
  if exists(select 1 from companion_private.chat_messages where chat_id = c.id and status = 'PENDING'
      and claimed_at > now() - interval '2 minutes') then
    return null;
  end if;
  loop
    select x.* into m from companion_private.chat_messages x
      join companion_private.chat_members mm on mm.chat_id = x.chat_id and mm.companion_id = x.companion_id
      where x.chat_id = c.id and x.status = 'PENDING' order by x.created_at, mm.position, x.id limit 1;
    if not found then
      if not skipped then return null; end if;
      -- A skipped turn ends like a finished one: another Companion may answer what was said.
      -- That queues at most one turn for a Companion that can take part, so this ends.
      skipped := false;
      perform companion_private.chat_queue_followup(c);
      continue;
    end if;
    perform companion_private.chat_abandon_compute(c.owner_id, m.compute_tx);
    exit when m.attempts < 3 and companion_private.chat_companion_ok(c.owner_id, m.companion_id);
    if m.optional then
      update companion_private.chat_messages set status = 'PASSED', shown_at = now(), typing_at = null, claim_id = null,
        compute_tx = null where id = m.id;
    else
      update companion_private.chat_messages set status = 'FAILED', shown_at = now(), typing_at = null, claim_id = null,
        compute_tx = null, failure = case when m.attempts >= 3 then 'ERROR' else 'UNAVAILABLE' end where id = m.id;
    end if;
    skipped := true;
  end loop;
  update companion_private.chat_messages set claim_id = claim, claimed_at = now(), attempts = attempts + 1, compute_tx = null
    where id = m.id;
  return jsonb_build_object('chatId', c.id, 'replyId', m.id, 'claimId', claim, 'replyTo', m.reply_to,
    'optional', m.optional, 'direct', c.direct_companion_id is not null,
    'companion', companion_private.chat_companion_json(m.companion_id)
      || jsonb_build_object('identity', (select i.identity_document from public.companions x
        join public.companion_identities i on i.id = x.current_identity_version_id where x.id = m.companion_id))
      || jsonb_build_object('settings', companion_private.chat_settings_json(companion_private.chat_settings_for(m.companion_id))),
    'members', companion_private.chat_members_json(c.id),
    'history', coalesce((select jsonb_agg(jsonb_build_object('companionId', q.companion_id, 'body', q.body,
        'mentions', to_jsonb(q.mentions), 'sentAt', q.shown_at) order by q.shown_at, q.id)
      from (select * from companion_private.chat_messages h where h.chat_id = c.id and h.status = 'SENT'
        order by h.shown_at desc, h.id desc limit 30) q), '[]'));
end $$;

-- Same as before, plus outcomes DISABLED and QUOTA, and an unsettled call is closed.
create or replace function public.chat_finish(p_reply uuid, p_claim uuid, p_outcome text, p_bodies text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid;
  v_bodies text[] := array(select btrim(b) from unnest(p_bodies) b); n integer := coalesce(cardinality(p_bodies), 0);
  pause interval := companion_private.chat_seconds(0.6); start_at timestamptz; done_at timestamptz; i integer;
  failed boolean := p_outcome in ('ERROR', 'UNAVAILABLE', 'DISABLED', 'QUOTA');
begin
  if p_outcome is null or p_outcome not in ('SENT', 'PASSED', 'BLOCKED', 'ERROR', 'UNAVAILABLE', 'DISABLED', 'QUOTA')
    or (p_outcome = 'SENT') <> (p_bodies is not null)
    or (p_outcome = 'SENT' and (n < 1 or n > 3 or exists(select 1 from unnest(v_bodies) b
      where b is null or b !~ '\S' or char_length(b) > 2000))) then
    raise exception using errcode='22023', message='invalid reply outcome';
  end if;
  select chat_id into v_chat from companion_private.chat_messages where id = p_reply;
  -- Lock the chat first, like every other writer; then the message cannot change under us.
  select * into c from companion_private.chats where id = v_chat and owner_id = companion_private.chat_owner() for update;
  if not found then return jsonb_build_object('accepted', false); end if;
  select * into m from companion_private.chat_messages where id = p_reply;
  if not found or m.status <> 'PENDING' or m.claim_id is distinct from p_claim then return jsonb_build_object('accepted', false); end if;
  if p_outcome = 'PASSED' and not m.optional then
    raise exception using errcode='22023', message='this turn must be answered';
  end if;
  perform companion_private.chat_abandon_compute(c.owner_id, m.compute_tx);
  -- Companions take turns visibly: typing starts after the last Companion message appeared.
  -- A turn that must answer has shown "typing" since typing_at, so time the model spent writing
  -- counts as typing; an optional turn starts typing only now that it decided to speak.
  select max(shown_at) + pause into done_at from companion_private.chat_messages
    where chat_id = c.id and companion_id is not null and status in ('SENT', 'FAILED', 'BLOCKED', 'PASSED');
  start_at := greatest(coalesce(m.typing_at, now()), coalesce(done_at, '-infinity'));
  if p_outcome = 'SENT' then
    for i in 1..n loop
      done_at := greatest(now(), start_at + companion_private.chat_seconds(least(6, greatest(1, 0.8 + 0.08 * char_length(v_bodies[i])))));
      if i = 1 then
        update companion_private.chat_messages set status = 'SENT', body = v_bodies[1], typing_at = start_at,
          shown_at = done_at, claim_id = null, compute_tx = null where id = m.id;
      else
        insert into companion_private.chat_messages(chat_id, companion_id, body, status, reply_to, optional, part,
            created_at, typing_at, shown_at)
          values (c.id, m.companion_id, v_bodies[i], 'SENT', m.reply_to, m.optional, i, m.created_at, start_at, done_at);
      end if;
      start_at := done_at + pause;
    end loop;
  else
    update companion_private.chat_messages set
      status = case when failed then 'FAILED' else p_outcome end,
      failure = case when failed then p_outcome end,
      typing_at = null, shown_at = greatest(now(), coalesce(done_at, now())), claim_id = null, compute_tx = null
    where id = m.id;
  end if;
  if p_outcome <> 'PASSED' then update companion_private.chats set active_at = now() where id = c.id returning * into c; end if;
  if not exists(select 1 from companion_private.chat_messages where chat_id = c.id and status = 'PENDING') then
    perform companion_private.chat_queue_followup(c);
  end if;
  return jsonb_build_object('accepted', true);
end $$;

-- Same as before, plus: queued Companion-to-Companion turns dropped here close their model calls.
create or replace function public.chat_send(p_chat uuid, p_body text, p_mentions uuid[], p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype;
  v_body text := btrim(p_body); v_mentions uuid[] := array(select unnest(p_mentions)); -- a plain list, like chat_open
begin
  c := companion_private.chat_for(p_chat);
  if v_body is null or v_body !~ '\S' or char_length(v_body) > 2000 or p_key is null or p_key !~ '^[a-f0-9]{64}$'
    or cardinality(v_mentions) > 8 or (select count(distinct x) from unnest(v_mentions) x where x is not null) <> cardinality(v_mentions)
    or exists(select 1 from unnest(v_mentions) x where not exists(
      select 1 from companion_private.chat_members where chat_id = c.id and companion_id = x)) then
    raise exception using errcode='22023', message='invalid message';
  end if;
  select * into m from companion_private.chat_messages where chat_id = c.id and key_hash = p_key;
  if found then
    if m.body is distinct from v_body or m.mentions <> v_mentions then
      raise exception using errcode='23505', message='idempotency conflict';
    end if;
    return jsonb_build_object('message', companion_private.chat_message_json(m)) || companion_private.chat_progress(c);
  end if;
  if (select count(*) from companion_private.chat_messages x join companion_private.chats y on y.id = x.chat_id
      where y.owner_id = c.owner_id and x.companion_id is null and x.created_at > now() - interval '1 hour') >= 300 then
    raise exception using errcode='55000', message='chat message limit reached';
  end if;
  insert into companion_private.chat_messages(chat_id, body, mentions, status, key_hash, shown_at)
    values (c.id, v_body, v_mentions, 'SENT', p_key, now()) returning * into m;
  -- The Owner spoke: Companions stop answering each other, including what they had not shown yet.
  perform companion_private.chat_abandon_compute(c.owner_id, x.compute_tx) from companion_private.chat_messages x
    where x.chat_id = c.id and x.reply_to = 'COMPANION' and x.status = 'PENDING' and x.compute_tx is not null;
  delete from companion_private.chat_messages where chat_id = c.id and reply_to = 'COMPANION'
    and (status = 'PENDING' or shown_at > now());
  -- must: one-to-one, @mentioned, or ACTIVE. may: NORMAL with no mention. QUIET: not queued.
  insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional, typing_at)
  select c.id, mm.companion_id, 'PENDING', 'OWNER', not k.must,
    case when k.must then now() + companion_private.chat_seconds(1 + 2 * random()) end
  from companion_private.chat_members mm
  left join companion_private.chat_settings s on s.companion_id = mm.companion_id
  cross join lateral (select coalesce(s.group_activity, 'NORMAL') as activity) a
  cross join lateral (select c.direct_companion_id is not null or mm.companion_id = any(v_mentions)
    or (cardinality(v_mentions) = 0 and a.activity = 'ACTIVE') as must) k
  where mm.chat_id = c.id and companion_private.chat_companion_ok(c.owner_id, mm.companion_id)
    and (k.must or (cardinality(v_mentions) = 0 and a.activity = 'NORMAL'));
  update companion_private.chats set active_at = now() where id = c.id returning * into c;
  return jsonb_build_object('message', companion_private.chat_message_json(m)) || companion_private.chat_progress(c);
end $$;

-- Same as before, plus: model calls still running for this chat are closed first.
create or replace function public.chat_delete(p_chat uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype;
begin
  c := companion_private.chat_for(p_chat);
  perform companion_private.chat_abandon_compute(c.owner_id, x.compute_tx) from companion_private.chat_messages x
    where x.chat_id = c.id and x.compute_tx is not null;
  delete from companion_private.chats where id = c.id;
  insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
    values (c.owner_id, 'OWNER', c.owner_id, 'CHAT_DELETE', 'CHAT', c.id);
  return jsonb_build_object('deleted', true);
end $$;

-- ---------- for the API server only (companion_api) ----------

-- Books one model call for a claimed turn and marks it started, right before the server calls the
-- model. Returns {"decision": "RESERVED", "transactionId"} or, without booking anything,
-- STALE (the turn moved on), DISABLED (switched off) or QUOTA (today's budget is used up).
create function public.chat_reserve(p_reply uuid, p_claim uuid, p_purpose text, p_provider text, p_model text,
  p_pricing_version text, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_trace text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid;
  q companion_private.chat_quota%rowtype; r record; key text;
  day timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_purpose is null or p_purpose not in ('REPLY', 'DECIDE') then
    raise exception using errcode='22023', message='invalid purpose';
  end if;
  select chat_id into v_chat from companion_private.chat_messages where id = p_reply;
  select * into c from companion_private.chats where id = v_chat and owner_id = companion_private.chat_owner() for update;
  if not found then return jsonb_build_object('decision', 'STALE'); end if;
  select * into m from companion_private.chat_messages where id = p_reply;
  if m.status <> 'PENDING' or m.claim_id is distinct from p_claim then return jsonb_build_object('decision', 'STALE'); end if;
  if not companion_private.model_enabled(p_provider, p_model) then return jsonb_build_object('decision', 'DISABLED'); end if;
  select * into q from companion_private.chat_quota;
  -- Today's free budget (the UTC day), created on first use. If another budget already covers part
  -- of today, none is created and the reservation below finds no budget: QUOTA.
  insert into public.compute_budgets(owner_id, companion_id, period_start, period_end, max_model_calls,
      max_input_tokens, max_output_tokens, max_cost_minor, currency)
    select c.owner_id, m.companion_id, day, day + interval '1 day', q.daily_calls, q.daily_calls::bigint * 16000,
      q.daily_calls::bigint * 2000, q.daily_cost_minor, q.currency
    where not exists(select 1 from public.compute_budgets b where b.owner_id = c.owner_id and b.companion_id = m.companion_id
      and b.period_start <= now() and now() < b.period_end)
    on conflict do nothing;
  key := encode(sha256(convert_to(m.claim_id::text || ':' || p_purpose,'UTF8')), 'hex');
  begin
    select * into r from companion_private.reserve_compute_transaction(c.owner_id, m.companion_id, null,
      case p_purpose when 'REPLY' then 'OWNER_DIRECT_RESPONSE' else 'CHAT_TURN_DECISION' end, 'CHAT_MESSAGE', m.id,
      p_provider, null, p_model, p_model, 'OWNER', q.currency, p_pricing_version, p_input_tokens, p_output_tokens, p_cost_minor,
      'chat/1', (select i.version from public.companions x join public.companion_identities i on i.id = x.current_identity_version_id
        where x.id = m.companion_id), null, 'chat-history/1', 'encounter-safety/0.1.0', 'chat-router/1',
      p_trace, m.attempts, null, key,
      encode(sha256(convert_to(concat_ws(':', key, p_provider, p_model, p_input_tokens, p_output_tokens, p_cost_minor),'UTF8')), 'hex'));
  exception when sqlstate 'P0001' then -- no budget covers now
    return jsonb_build_object('decision', 'QUOTA', 'reason', 'NO_BUDGET');
  end;
  if r.decision <> 'RESERVED' then return jsonb_build_object('decision', 'QUOTA', 'reason', r.outcome_code); end if;
  perform companion_private.start_compute_transaction(c.owner_id, r.transaction_id);
  update companion_private.chat_messages set compute_tx = r.transaction_id where id = m.id;
  return jsonb_build_object('decision', 'RESERVED', 'transactionId', r.transaction_id);
end $$;

-- Settles a started chat model call with what the provider reported (p_ok false: the call failed;
-- send the reservation when usage is unknown). Works even if the turn or chat is gone meanwhile.
-- A call already closed as abandoned (the turn timed out or was deleted) stays as it is: {"settled": false}.
create function public.chat_settle(p_transaction uuid, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_ok boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  perform 1 from public.compute_transactions where id = p_transaction and owner_id = o
    and trigger_event_type = 'CHAT_MESSAGE' for update;
  if not found then raise exception using errcode='P0001', message='chat compute transaction not found'; end if;
  if (select status from public.compute_ledger_entries where transaction_id = p_transaction order by sequence desc limit 1) <> 'STARTED' then
    return jsonb_build_object('settled', false);
  end if;
  perform companion_private.settle_compute_transaction(o, p_transaction, p_input_tokens, p_output_tokens, p_cost_minor,
    case when p_ok then 'SUCCEEDED' else 'FAILED' end, case when p_ok then null else 'PROVIDER_ERROR' end, null);
  return jsonb_build_object('settled', true);
end $$;

-- For the Owner's model picker: whether each catalog model is switched on, in the order given.
create function public.chat_models_enabled(p_providers text[], p_models text[])
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(companion_private.model_enabled(t.provider, t.model) order by t.i), '[]')
  from unnest(p_providers, p_models) with ordinality as t(provider, model, i)
  where companion_private.chat_owner() is not null
$$;

revoke all on function companion_private.model_enabled(text, text), companion_private.admin_set_model_switch(text, text, boolean, text),
  companion_private.admin_set_chat_quota(integer, bigint), companion_private.chat_abandon_compute(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.chat_update_settings(uuid, text, text, text, integer), public.chat_models_enabled(text[], text[]),
  public.chat_reserve(uuid, uuid, text, text, text, text, bigint, bigint, bigint, text), public.chat_settle(uuid, bigint, bigint, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.chat_update_settings(uuid, text, text, text, integer), public.chat_models_enabled(text[], text[]) to authenticated;
-- Booking and settling model calls is the server's job: not reachable through Supabase's own REST API.
grant execute on function public.chat_reserve(uuid, uuid, text, text, text, text, bigint, bigint, bigint, text),
  public.chat_settle(uuid, bigint, bigint, bigint, boolean) to companion_api;

commit;
