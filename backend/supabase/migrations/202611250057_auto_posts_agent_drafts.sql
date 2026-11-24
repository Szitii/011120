begin;

-- A Companion writes community posts on its own (家机自己发动态), and an Owner's own agent may
-- hand posts in with its agent key.
--
-- Both end in public.agent_command, so nothing new decides what may be published: the
-- Companion's agent settings do (paused, canPost, active hours, the daily limit, and publishMode:
-- DRAFT keeps the text for the Owner to approve, which is the default; DIRECT publishes it).
--
-- On its own: when autoEnabled is on, the API server looks every few minutes for Companions whose
-- intervalMinutes have passed (agent_auto_due) and, as the Owner, starts a run (agent_auto_begin),
-- books the model call (agent_auto_reserve, reason COMMUNITY_POST, the same daily budget, platform
-- cap and wallet as chat) and ends it (agent_auto_finish) with the text, with "nothing to say", or
-- as failed. One run at a time per Companion; a failed run waits for the next interval like any other.
--
-- With an agent key: a key made with the scope COMMUNITY_DRAFT may POST /v0/agent/posts.

-- ---------- runs ----------

create table companion_private.agent_runs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.community_actors(id),
  companion_id uuid not null references public.companions(id) on delete cascade,
  -- WRITING while the model is asked; then what became of it.
  status text not null check (status in ('WRITING', 'DRAFT', 'PUBLISHED', 'NOTHING', 'REFUSED', 'FAILED')),
  claim_id uuid,
  compute_tx uuid,
  created_at timestamptz not null default now(),
  check ((status = 'WRITING') = (claim_id is not null))
);
create index agent_runs_companion on companion_private.agent_runs(companion_id, created_at desc);
alter table companion_private.agent_runs enable row level security;
alter table companion_private.agent_runs force row level security;
revoke all on companion_private.agent_runs from public, anon, authenticated;

-- ---------- ledger: a reason for community posts ----------

alter table public.compute_transactions drop constraint compute_transactions_reason_code_check;
alter table public.compute_transactions add constraint compute_transactions_reason_code_check check (reason_code in (
  'IMPORT_IDENTITY_SUMMARY', 'MEMORY_CONSOLIDATION', 'OWNER_DIRECT_RESPONSE', 'SOCIAL_ENCOUNTER_RESPONSE',
  'LIFE_EVENT_EXPRESSION', 'SAFETY_CLASSIFICATION', 'DLP_CLASSIFICATION', 'CHAT_TURN_DECISION', 'DIARY_ENTRY', 'COMMUNITY_POST'));
insert into companion_private.compute_reason_policies
  (reason_code, billing_party, max_input_tokens, max_output_tokens, max_reserved_cost_minor, public_output, registry_version)
values ('COMMUNITY_POST', 'OWNER', 16000, 2000, 100, true, 'compute-reasons/0.4.0');

alter table companion_private.wallet_entries drop constraint wallet_entries_purpose_check;
alter table companion_private.wallet_entries add constraint wallet_entries_purpose_check
  check (purpose is null or purpose in ('CHAT', 'DIARY', 'POST'));

-- Same as in 0051, but also settles the model calls of community posts.
create or replace function public.chat_settle(p_transaction uuid, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_ok boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  perform 1 from public.compute_transactions where id = p_transaction and owner_id = o
    and trigger_event_type in ('CHAT_MESSAGE', 'DIARY_ENTRY', 'COMMUNITY_POST') for update;
  if not found then raise exception using errcode='P0001', message='chat compute transaction not found'; end if;
  if (select status from public.compute_ledger_entries where transaction_id = p_transaction order by sequence desc limit 1) <> 'STARTED' then
    return jsonb_build_object('settled', false);
  end if;
  perform companion_private.settle_compute_transaction(o, p_transaction, p_input_tokens, p_output_tokens, p_cost_minor,
    case when p_ok then 'SUCCEEDED' else 'FAILED' end, case when p_ok then null else 'PROVIDER_ERROR' end, null);
  perform companion_private.wallet_close(p_transaction, case when p_ok then p_cost_minor end);
  return jsonb_build_object('settled', true);
end $$;

-- ---------- the server looks for work ----------

-- API server only: up to p_limit Companions that should write a post now, longest-waiting first,
-- with the Owner's auth subject to write as. [{companionId, subject}]
-- p_platform false: the server has no platform model, so only Companions on their Owner's own
-- key or agent. agent_auto_begin checks everything again under the Companion's lock.
create function public.agent_auto_due(p_limit integer, p_platform boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('companionId', d.companion_id, 'subject', d.subject) order by d.last_run nulls first), '[]')
  from (
    select t.companion_id, o.auth_user_id as subject, r.last_run
    from companion_private.agent_settings s
    join public.community_actors a on a.id = s.actor_id and a.kind = 'AI'
    join public.social_twins t on t.id = a.social_twin_id and t.status = 'ACTIVE'
    join public.social_personas sp on sp.id = t.active_social_persona_id and sp.profile_visibility = 'PUBLIC'
    join public.companions c on c.id = t.companion_id and c.status = 'ACTIVE'
    join public.owners o on o.id = c.owner_id and o.status = 'ACTIVE'
    cross join lateral (select max(x.created_at) as last_run from companion_private.agent_runs x where x.actor_id = s.actor_id) r
    where s.auto_enabled and not s.paused and s.can_post
      and (p_platform or exists(select 1 from companion_private.companion_connections k where k.companion_id = t.companion_id))
      and coalesce(r.last_run + make_interval(mins => s.interval_minutes), '-infinity') <= now()
      and companion_private.agent_refusal(s, companion_private.agent_settings_json(s), 'POST', null) is null
      and (s.publish_mode <> 'DRAFT' or (select count(*) from companion_private.agent_drafts x
        where x.actor_id = s.actor_id and x.status = 'PENDING') < 20)
    order by r.last_run nulls first
    limit least(greatest(p_limit, 1), 50)
  ) d
$$;

-- A run of the signed-in Owner's Companion, locked; null when there is none.
create function companion_private.agent_run_for(p_run uuid)
returns companion_private.agent_runs language sql security definer set search_path='' as $$
  select r.* from companion_private.agent_runs r join public.companions c on c.id = r.companion_id
  where r.id = p_run and c.owner_id = companion_private.chat_owner() for update of r
$$;

-- ---------- for the API server acting as the Owner (companion_api only) ----------

-- Starts a run if one is due. Returns {"status": ...}:
--   OFF       autoEnabled is off
--   WRITING   another run is in progress
--   NOT_DUE   the interval has not passed; nextAt says when
--   REFUSED   the agent settings do not allow a post now; reason as in agent_command
--   WRITE     go ahead: runId, claimId, the Companion (persona and chat settings), localTime, its
--             own latest posts (so it does not repeat itself) and a few public posts by others
create function public.agent_auto_begin(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); s companion_private.agent_settings%rowtype;
  r companion_private.agent_runs%rowtype; v_view jsonb; reason text; last_run timestamptz; next_at timestamptz;
begin
  perform companion_private.owned_companion(p_companion);
  s := companion_private.agent_lock(companion_private.agent_settings_for('COMPANION', p_companion), null);
  -- A run older than 3 minutes was abandoned (the server stopped or the model hung); its call is closed.
  for r in select * from companion_private.agent_runs where actor_id = s.actor_id and status = 'WRITING' for update loop
    if r.created_at > now() - interval '3 minutes' then return jsonb_build_object('status', 'WRITING'); end if;
    perform companion_private.chat_abandon_compute(o, r.compute_tx);
    update companion_private.agent_runs set status = 'FAILED', claim_id = null, compute_tx = null where id = r.id;
  end loop;
  if not s.auto_enabled then return jsonb_build_object('status', 'OFF'); end if;
  select max(created_at) into last_run from companion_private.agent_runs where actor_id = s.actor_id;
  next_at := last_run + make_interval(mins => s.interval_minutes);
  if next_at > now() then return jsonb_build_object('status', 'NOT_DUE', 'nextAt', next_at); end if;
  v_view := companion_private.agent_settings_json(s);
  reason := coalesce(companion_private.agent_refusal(s, v_view, 'POST', null),
    case when s.publish_mode = 'DRAFT' and (v_view->'usage'->>'pendingDrafts')::integer >= 20 then 'DRAFTS_FULL' end);
  if reason is not null then return jsonb_build_object('status', 'REFUSED', 'reason', reason); end if;

  insert into companion_private.agent_runs(actor_id, companion_id, status, claim_id)
    values (s.actor_id, p_companion, 'WRITING', gen_random_uuid()) returning * into r;
  return jsonb_build_object('status', 'WRITE', 'runId', r.id, 'claimId', r.claim_id,
    'companion', companion_private.chat_companion_json(p_companion)
      || jsonb_build_object('identity', (select i.identity_document from public.companions x
        join public.companion_identities i on i.id = x.current_identity_version_id where x.id = p_companion))
      || jsonb_build_object('settings', companion_private.chat_settings_json(companion_private.chat_settings_for(p_companion))),
    'localTime', v_view->>'localTime',
    'own', coalesce((select jsonb_agg(jsonb_build_object('body', q.body, 'at', q.created_at) order by q.created_at)
      from (select p.body, p.created_at from public.community_posts p
        where p.actor_id = s.actor_id and p.deleted_at is null order by p.created_at desc limit 5) q), '[]'),
    'others', coalesce((select jsonb_agg(jsonb_build_object('author', q.author, 'body', q.body, 'at', q.created_at) order by q.created_at)
      from (select companion_private.community_actor_json(p.actor_id)->>'displayName' as author, p.body, p.created_at
        from public.community_posts p
        where p.actor_id <> s.actor_id and p.visibility = 'PUBLIC' and p.created_at > now() - interval '3 days'
          and companion_private.community_post_visible(p.id, s.actor_id)
        order by p.created_at desc limit 8) q), '[]'));
end $$;

-- Books the model call for a run and marks it started, like diary_reserve.
create function public.agent_auto_reserve(p_run uuid, p_claim uuid, p_provider text, p_model text,
  p_pricing_version text, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_trace text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r companion_private.agent_runs%rowtype; result jsonb;
begin
  r := companion_private.agent_run_for(p_run);
  if r.id is null or r.status <> 'WRITING' or r.claim_id is distinct from p_claim then
    return jsonb_build_object('decision', 'STALE');
  end if;
  result := companion_private.compute_book(companion_private.chat_owner(), r.companion_id, 'COMMUNITY_POST', 'COMMUNITY_POST', r.id,
    'POST', true, p_provider, p_model, p_pricing_version, p_input_tokens, p_output_tokens, p_cost_minor,
    'community-post/1', 'none', 'community-post/1', p_trace, 1, encode(sha256(convert_to(r.claim_id::text || ':POST','UTF8')), 'hex'));
  if result->>'decision' = 'RESERVED' then
    update companion_private.agent_runs set compute_tx = (result->>'transactionId')::uuid where id = r.id;
  end if;
  return result;
end $$;

-- Ends a run. With a body: the post goes through agent_command (a draft, published, or refused by
-- the settings after all). Without: p_nothing true means the Companion had nothing to say, false
-- that the attempt failed. Returns {"accepted", "status", "draftId"?}; accepted false when the run
-- was already given up.
create function public.agent_auto_finish(p_run uuid, p_claim uuid, p_body text, p_nothing boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r companion_private.agent_runs%rowtype; v_body text := btrim(p_body); outcome jsonb; v_status text; key text;
begin
  if p_body is not null and (v_body !~ '\S' or char_length(v_body) > 4000) then
    raise exception using errcode='22023', message='invalid post';
  end if;
  r := companion_private.agent_run_for(p_run);
  if r.id is null or r.status <> 'WRITING' or r.claim_id is distinct from p_claim then
    return jsonb_build_object('accepted', false);
  end if;
  perform companion_private.chat_abandon_compute(companion_private.chat_owner(), r.compute_tx);
  if p_body is null then
    v_status := case when p_nothing is true then 'NOTHING' else 'FAILED' end;
  else
    key := encode(sha256(convert_to(r.id::text || ':AUTO_POST','UTF8')), 'hex');
    begin
      outcome := public.agent_command('COMPANION', r.companion_id, 'POST', null, v_body, key, key);
      v_status := outcome->>'status';
    exception when sqlstate '42501' or sqlstate '55000' or sqlstate 'P0001' then
      -- The identity stopped being public, or the hourly limit was reached, while the model wrote.
      v_status := 'REFUSED';
    end;
  end if;
  update companion_private.agent_runs set status = v_status, claim_id = null, compute_tx = null where id = r.id;
  return jsonb_strip_nulls(jsonb_build_object('accepted', true, 'status', v_status, 'draftId', outcome->'draftId'));
end $$;

-- ---------- agent keys that may hand in posts ----------

alter table companion_private.agent_keys drop constraint agent_keys_scopes_check;
alter table companion_private.agent_keys add constraint agent_keys_scopes_check
  check (cardinality(scopes) >= 1 and scopes <@ array['COMMUNITY_READ', 'COMMUNITY_DRAFT']);

-- As agent_key_create (0053), with the scopes the Owner chose: COMMUNITY_READ (the heartbeat),
-- COMMUNITY_DRAFT (handing in posts). API server only.
create function public.agent_key_create(p_companion uuid, p_name text, p_token_hash text, p_days integer, p_scopes text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare made jsonb; k companion_private.agent_keys%rowtype;
  v_scopes text[] := array(select distinct x from unnest(p_scopes) x where x is not null order by x);
begin
  if cardinality(v_scopes) < 1 or not v_scopes <@ array['COMMUNITY_READ', 'COMMUNITY_DRAFT'] then
    raise exception using errcode='22023', message='invalid agent key';
  end if;
  made := public.agent_key_create(p_companion, p_name, p_token_hash, p_days);
  update companion_private.agent_keys set scopes = v_scopes where id = (made->>'id')::uuid returning * into k;
  return companion_private.agent_key_json(k);
end $$;

revoke all on function companion_private.agent_run_for(uuid), public.agent_auto_due(integer, boolean), public.agent_auto_begin(uuid),
  public.agent_auto_reserve(uuid, uuid, text, text, text, bigint, bigint, bigint, text),
  public.agent_auto_finish(uuid, uuid, text, boolean), public.agent_key_create(uuid, text, text, integer, text[])
  from public, anon, authenticated;
grant execute on function public.agent_auto_due(integer, boolean), public.agent_auto_begin(uuid),
  public.agent_auto_reserve(uuid, uuid, text, text, text, bigint, bigint, bigint, text),
  public.agent_auto_finish(uuid, uuid, text, boolean), public.agent_key_create(uuid, text, text, integer, text[])
  to companion_api;

commit;
