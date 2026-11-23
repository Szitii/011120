begin;

-- Companion diary (家机日记): a Companion writes short first-person entries about its days with
-- the Owner. Only the Owner reads them.
--
--  * Material: since the previous entry (at most the last 3 days), the one-to-one chat with the
--    Owner (messages and home-room actions) and the Companion's own community posts and comments.
--    No Owner message, action, post or comment in that window: nothing is written (no inventing).
--  * When: the app asks (diary_begin) when the Owner opens the diary. An entry is written only if
--    the Companion's frequency says one is due: OFF never, RARE every 72 h, DAILY every 20 h,
--    OFTEN every 6 h, counted from the previous entry. No scheduler, so nothing is spent on
--    diaries nobody opens.
--  * Writing is the API server's job (diary_begin / diary_reserve / diary_finish, companion_api
--    only), one at a time per Companion. A model call is booked in the compute ledger under the
--    new reason DIARY_ENTRY and counts toward the Companion's free daily budget. A failed attempt
--    blocks another for 10 minutes; an attempt older than 3 minutes counts as failed.
--  * The Owner may delete an entry. Its text is erased, but the row keeps the window it covered,
--    so the next entry does not retell the same days.
--  * Private by structure, like chat: tables in companion_private without grants, reached only
--    through the diary_* functions.

create table companion_private.diary_settings (
  companion_id uuid primary key references public.companions(id) on delete cascade,
  frequency text not null default 'DAILY' check (frequency in ('OFF', 'RARE', 'DAILY', 'OFTEN')),
  revision integer not null default 1 check (revision >= 1)
);

create table companion_private.diary_entries (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references public.companions(id) on delete cascade,
  status text not null check (status in ('WRITING', 'DONE', 'FAILED', 'DELETED')),
  body text check (body is null or char_length(body) between 1 and 2000),
  covers_from timestamptz not null,
  covers_until timestamptz not null,
  claim_id uuid,
  -- The ledger transaction of the model call running for this attempt, if any.
  compute_tx uuid references public.compute_transactions(id),
  created_at timestamptz not null default now(),
  check ((status = 'DONE') = (body is not null)),
  check ((status = 'WRITING') = (claim_id is not null)),
  check (covers_from <= covers_until)
);
create index diary_entries_companion on companion_private.diary_entries(companion_id, created_at desc, id desc);

alter table companion_private.diary_settings enable row level security;
alter table companion_private.diary_settings force row level security;
alter table companion_private.diary_entries enable row level security;
alter table companion_private.diary_entries force row level security;
revoke all on companion_private.diary_settings, companion_private.diary_entries from public, anon, authenticated;

-- ---------- ledger: a reason for diary entries ----------

alter table public.compute_transactions drop constraint compute_transactions_reason_code_check;
alter table public.compute_transactions add constraint compute_transactions_reason_code_check check (reason_code in (
  'IMPORT_IDENTITY_SUMMARY', 'MEMORY_CONSOLIDATION', 'OWNER_DIRECT_RESPONSE', 'SOCIAL_ENCOUNTER_RESPONSE',
  'LIFE_EVENT_EXPRESSION', 'SAFETY_CLASSIFICATION', 'DLP_CLASSIFICATION', 'CHAT_TURN_DECISION', 'DIARY_ENTRY'));
insert into companion_private.compute_reason_policies
  (reason_code, billing_party, max_input_tokens, max_output_tokens, max_reserved_cost_minor, public_output, registry_version)
values ('DIARY_ENTRY', 'OWNER', 16000, 2000, 100, false, 'compute-reasons/0.3.0');

-- Same as in 0041, but also settles diary model calls.
create or replace function public.chat_settle(p_transaction uuid, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_ok boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  perform 1 from public.compute_transactions where id = p_transaction and owner_id = o
    and trigger_event_type in ('CHAT_MESSAGE', 'DIARY_ENTRY') for update;
  if not found then raise exception using errcode='P0001', message='chat compute transaction not found'; end if;
  if (select status from public.compute_ledger_entries where transaction_id = p_transaction order by sequence desc limit 1) <> 'STARTED' then
    return jsonb_build_object('settled', false);
  end if;
  perform companion_private.settle_compute_transaction(o, p_transaction, p_input_tokens, p_output_tokens, p_cost_minor,
    case when p_ok then 'SUCCEEDED' else 'FAILED' end, case when p_ok then null else 'PROVIDER_ERROR' end, null);
  return jsonb_build_object('settled', true);
end $$;

-- ---------- helpers ----------

-- The signed-in Owner's Companion's diary settings, created with defaults on first use and locked,
-- so two requests for one Companion's diary run one after the other.
create function companion_private.diary_settings_for(p_companion uuid)
returns companion_private.diary_settings language plpgsql security definer set search_path='' as $$
declare s companion_private.diary_settings%rowtype;
begin
  if not companion_private.chat_companion_ok(companion_private.chat_owner(), p_companion) then
    raise exception using errcode='P0001', message='companion not found';
  end if;
  insert into companion_private.diary_settings(companion_id) values (p_companion) on conflict do nothing;
  select * into s from companion_private.diary_settings where companion_id = p_companion for update;
  return s;
end $$;

create function companion_private.diary_settings_json(s companion_private.diary_settings)
returns jsonb language sql immutable as $$
  select jsonb_build_object('frequency', s.frequency, 'revision', s.revision)
$$;

-- How long after one entry the next may be written.
create function companion_private.diary_interval(p_frequency text)
returns interval language sql immutable as $$
  select case p_frequency when 'RARE' then interval '72 hours' when 'OFTEN' then interval '6 hours' else interval '20 hours' end
$$;

create function companion_private.diary_entry_json(e companion_private.diary_entries)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', e.id, 'companionId', e.companion_id, 'body', e.body, 'writtenAt', e.created_at)
$$;

-- An entry of the signed-in Owner's Companion, locked; null when there is none.
create function companion_private.diary_entry_for(p_entry uuid)
returns companion_private.diary_entries language sql security definer set search_path='' as $$
  select e.* from companion_private.diary_entries e join public.companions c on c.id = e.companion_id
  where e.id = p_entry and c.owner_id = companion_private.chat_owner() for update of e
$$;

-- ---------- for the Owner (authenticated) ----------

create function public.diary_get_settings(p_companion uuid)
returns jsonb language sql security definer set search_path='' as $$
  select companion_private.diary_settings_json(companion_private.diary_settings_for(p_companion))
$$;

-- A stale revision (another device saved first) is a conflict.
create function public.diary_update_settings(p_companion uuid, p_frequency text, p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.diary_settings%rowtype; o uuid := companion_private.chat_owner();
begin
  if p_frequency is null or p_frequency not in ('OFF', 'RARE', 'DAILY', 'OFTEN') then
    raise exception using errcode='22023', message='invalid diary frequency';
  end if;
  s := companion_private.diary_settings_for(p_companion);
  update companion_private.diary_settings set frequency = p_frequency, revision = revision + 1
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='diary settings revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'DIARY_UPDATE_SETTINGS', 'COMPANION', s.companion_id);
  return companion_private.diary_settings_json(s);
end $$;

-- A page of entries, newest first, 20 per page with a cursor "writtenAt|id"; `writing` while an
-- entry is being written.
create function public.diary_list(p_companion uuid, p_before_at timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb; n integer; last_item jsonb;
begin
  if (p_before_at is null) <> (p_before_id is null) then raise exception using errcode='22023', message='invalid cursor'; end if;
  if not companion_private.chat_companion_ok(companion_private.chat_owner(), p_companion) then
    raise exception using errcode='P0001', message='companion not found';
  end if;
  select coalesce(jsonb_agg(companion_private.diary_entry_json(q.e) order by (q.e).created_at desc, (q.e).id desc), '[]') into items
  from (select e from companion_private.diary_entries e
    where e.companion_id = p_companion and e.status = 'DONE'
      and (p_before_at is null or (e.created_at, e.id) < (p_before_at, p_before_id))
    order by e.created_at desc, e.id desc limit 21) q;
  n := jsonb_array_length(items);
  if n > 20 then items := items - 20; end if;
  last_item := items->(jsonb_array_length(items) - 1);
  return jsonb_build_object('items', items,
    'nextCursor', case when n > 20 then to_char((last_item->>'writtenAt')::timestamptz at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || (last_item->>'id') end,
    'writing', exists(select 1 from companion_private.diary_entries e where e.companion_id = p_companion
      and e.status = 'WRITING' and e.created_at > now() - interval '3 minutes'));
end $$;

-- Erases an entry's text. The row stays (as DELETED) so the next entry starts after it.
create function public.diary_delete(p_companion uuid, p_entry uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e companion_private.diary_entries%rowtype; o uuid := companion_private.chat_owner();
begin
  e := companion_private.diary_entry_for(p_entry);
  if e.id is null or e.companion_id <> p_companion or e.status <> 'DONE' then
    raise exception using errcode='P0001', message='diary entry not found';
  end if;
  update companion_private.diary_entries set status = 'DELETED', body = null where id = e.id;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, e.companion_id, 'OWNER', o, 'DIARY_DELETE', 'DIARY_ENTRY', e.id);
  return jsonb_build_object('deleted', true);
end $$;

-- ---------- for the API server only (companion_api) ----------

-- Starts an entry if one is due. Returns {"status": ...}:
--   OFF          the Owner turned the diary off
--   WRITING      another request is writing one right now
--   NOT_DUE      too soon after the previous entry or a failed attempt; nextAt says when
--   NOTHING_NEW  nothing happened since the previous entry
--   WRITE        go ahead: entryId, claimId, the Companion (persona and chat settings), and the
--                material: messages (one-to-one chat, oldest first) and posts (own posts and comments)
create function public.diary_begin(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.diary_settings%rowtype; o uuid := companion_private.chat_owner();
  e companion_private.diary_entries%rowtype; last_done timestamptz; last_failed timestamptz;
  v_from timestamptz; v_until timestamptz := now(); next_at timestamptz; messages jsonb; posts jsonb;
begin
  s := companion_private.diary_settings_for(p_companion); -- checks the Companion and locks its diary
  -- An attempt older than 3 minutes was abandoned (the server stopped or the model hung). Its call
  -- is closed even when the diary was turned off meanwhile. Locked, so a finish racing this wins or waits.
  for e in select * from companion_private.diary_entries where companion_id = p_companion and status = 'WRITING' for update loop
    if e.created_at > now() - interval '3 minutes' then return jsonb_build_object('status', 'WRITING'); end if;
    perform companion_private.chat_abandon_compute(o, e.compute_tx);
    update companion_private.diary_entries set status = 'FAILED', claim_id = null, compute_tx = null where id = e.id;
  end loop;
  if s.frequency = 'OFF' then return jsonb_build_object('status', 'OFF'); end if;
  select max(created_at) filter (where status in ('DONE', 'DELETED')), max(created_at) filter (where status = 'FAILED'),
      max(covers_until) filter (where status in ('DONE', 'DELETED'))
    into last_done, last_failed, v_from
    from companion_private.diary_entries where companion_id = p_companion;
  next_at := greatest(last_done + companion_private.diary_interval(s.frequency), last_failed + interval '10 minutes');
  if next_at > now() then return jsonb_build_object('status', 'NOT_DUE', 'nextAt', next_at); end if;
  v_from := greatest(v_from, now() - interval '3 days');

  -- The one-to-one chat; of several actions in a row only the last, as in chat_claim.
  select coalesce(jsonb_agg(jsonb_build_object('companionId', q.companion_id, 'body', q.body, 'action', q.action,
      'sentAt', q.shown_at) order by q.shown_at, q.id), '[]') into messages
  from (select h.* from companion_private.chat_messages h join companion_private.chats c on c.id = h.chat_id
    where c.owner_id = o and c.direct_companion_id = p_companion and h.status = 'SENT'
      and h.shown_at > v_from and h.shown_at <= v_until
      and (h.action is null or (select n.action from companion_private.chat_messages n
        where n.chat_id = h.chat_id and n.status = 'SENT' and (n.shown_at, n.id) > (h.shown_at, h.id)
        order by n.shown_at, n.id limit 1) is null)
    order by h.shown_at desc, h.id desc limit 200) q;
  -- Its own community posts and comments (not deleted).
  select coalesce(jsonb_agg(jsonb_build_object('kind', q.kind, 'body', q.body, 'at', q.created_at) order by q.created_at), '[]')
    into posts
  from (select * from (
      select 'POST' as kind, p.body, p.created_at from public.community_posts p
        join public.community_actors a on a.id = p.actor_id join public.social_twins t on t.id = a.social_twin_id
        where t.companion_id = p_companion and p.deleted_at is null and p.created_at > v_from and p.created_at <= v_until
      union all
      select 'COMMENT', m.body, m.created_at from public.community_comments m
        join public.community_actors a on a.id = m.actor_id join public.social_twins t on t.id = a.social_twin_id
        where t.companion_id = p_companion and m.deleted_at is null and m.created_at > v_from and m.created_at <= v_until
    ) x order by x.created_at desc limit 10) q;
  if not exists(select 1 from jsonb_array_elements(messages) m where m->>'companionId' is null)
    and jsonb_array_length(posts) = 0 then
    return jsonb_build_object('status', 'NOTHING_NEW');
  end if;

  insert into companion_private.diary_entries(companion_id, status, covers_from, covers_until, claim_id)
    values (p_companion, 'WRITING', v_from, v_until, gen_random_uuid()) returning * into e;
  return jsonb_build_object('status', 'WRITE', 'entryId', e.id, 'claimId', e.claim_id,
    'companion', companion_private.chat_companion_json(p_companion)
      || jsonb_build_object('identity', (select i.identity_document from public.companions x
        join public.companion_identities i on i.id = x.current_identity_version_id where x.id = p_companion))
      || jsonb_build_object('settings', companion_private.chat_settings_json(companion_private.chat_settings_for(p_companion))),
    'messages', messages, 'posts', posts);
end $$;

-- Books the model call for an attempt and marks it started, like chat_reserve. Returns
-- {"decision": "RESERVED", "transactionId"} or STALE / DISABLED / QUOTA without booking anything.
create function public.diary_reserve(p_entry uuid, p_claim uuid, p_provider text, p_model text,
  p_pricing_version text, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_trace text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e companion_private.diary_entries%rowtype; o uuid := companion_private.chat_owner();
  q companion_private.chat_quota%rowtype; r record; key text;
  day timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  e := companion_private.diary_entry_for(p_entry);
  if e.id is null or e.status <> 'WRITING' or e.claim_id is distinct from p_claim then
    return jsonb_build_object('decision', 'STALE');
  end if;
  if not companion_private.model_enabled(p_provider, p_model) then return jsonb_build_object('decision', 'DISABLED'); end if;
  select * into q from companion_private.chat_quota;
  -- The same free daily budget as chat (see chat_reserve).
  insert into public.compute_budgets(owner_id, companion_id, period_start, period_end, max_model_calls,
      max_input_tokens, max_output_tokens, max_cost_minor, currency)
    select o, e.companion_id, day, day + interval '1 day', q.daily_calls, q.daily_calls::bigint * 16000,
      q.daily_calls::bigint * 2000, q.daily_cost_minor, q.currency
    where not exists(select 1 from public.compute_budgets b where b.owner_id = o and b.companion_id = e.companion_id
      and b.period_start <= now() and now() < b.period_end)
    on conflict do nothing;
  key := encode(public.digest(e.claim_id::text || ':DIARY', 'sha256'), 'hex');
  begin
    select * into r from companion_private.reserve_compute_transaction(o, e.companion_id, null,
      'DIARY_ENTRY', 'DIARY_ENTRY', e.id, p_provider, null, p_model, p_model, 'OWNER', q.currency, p_pricing_version,
      p_input_tokens, p_output_tokens, p_cost_minor,
      'diary/1', (select i.version from public.companions x join public.companion_identities i on i.id = x.current_identity_version_id
        where x.id = e.companion_id), null, 'diary-material/1', 'encounter-safety/0.1.0', 'diary/1',
      p_trace, 1, null, key,
      encode(public.digest(concat_ws(':', key, p_provider, p_model, p_input_tokens, p_output_tokens, p_cost_minor), 'sha256'), 'hex'));
  exception when sqlstate 'P0001' then -- no budget covers now
    return jsonb_build_object('decision', 'QUOTA', 'reason', 'NO_BUDGET');
  end;
  if r.decision <> 'RESERVED' then return jsonb_build_object('decision', 'QUOTA', 'reason', r.outcome_code); end if;
  perform companion_private.start_compute_transaction(o, r.transaction_id);
  update companion_private.diary_entries set compute_tx = r.transaction_id where id = e.id;
  return jsonb_build_object('decision', 'RESERVED', 'transactionId', r.transaction_id);
end $$;

-- Ends an attempt: with a body the entry is kept, with null it failed. Returns {"accepted", "entry"};
-- accepted false when the attempt was already given up.
create function public.diary_finish(p_entry uuid, p_claim uuid, p_body text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e companion_private.diary_entries%rowtype; v_body text := btrim(p_body);
begin
  if p_body is not null and (v_body !~ '\S' or char_length(v_body) > 2000) then
    raise exception using errcode='22023', message='invalid diary entry';
  end if;
  e := companion_private.diary_entry_for(p_entry);
  if e.id is null or e.status <> 'WRITING' or e.claim_id is distinct from p_claim then
    return jsonb_build_object('accepted', false, 'entry', null);
  end if;
  perform companion_private.chat_abandon_compute(companion_private.chat_owner(), e.compute_tx);
  update companion_private.diary_entries set status = case when p_body is null then 'FAILED' else 'DONE' end,
    body = v_body, claim_id = null, compute_tx = null where id = e.id returning * into e;
  return jsonb_build_object('accepted', true,
    'entry', case when e.status = 'DONE' then companion_private.diary_entry_json(e) end);
end $$;

revoke all on function companion_private.diary_settings_for(uuid), companion_private.diary_settings_json(companion_private.diary_settings),
  companion_private.diary_interval(text), companion_private.diary_entry_json(companion_private.diary_entries),
  companion_private.diary_entry_for(uuid)
  from public, anon, authenticated;
revoke all on function public.diary_get_settings(uuid), public.diary_update_settings(uuid, text, integer),
  public.diary_list(uuid, timestamptz, uuid), public.diary_delete(uuid, uuid), public.diary_begin(uuid),
  public.diary_reserve(uuid, uuid, text, text, text, bigint, bigint, bigint, text), public.diary_finish(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.diary_get_settings(uuid), public.diary_update_settings(uuid, text, integer),
  public.diary_list(uuid, timestamptz, uuid), public.diary_delete(uuid, uuid) to authenticated;
-- Writing a Companion's words is the server's job: not reachable through Supabase's own REST API.
grant execute on function public.diary_begin(uuid), public.diary_reserve(uuid, uuid, text, text, text, bigint, bigint, bigint, text),
  public.diary_finish(uuid, uuid, text) to companion_api;

commit;
