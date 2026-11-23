begin;

-- Admin console, step 1: everything an operator may do, as functions in one schema.
--
--  * Operators connect with their own database login, a member of companion_admin. That role can
--    execute the functions in schema companion_admin and nothing else: no table, no other function.
--  * Every change, and every read of a private chat, needs a reason and writes one row to
--    companion_private.admin_log in the same transaction. The log names the login that connected
--    (session_user), cannot be edited or deleted, and keeps what is needed to undo the change.
--  * Suspending an Owner or a Social Twin uses the statuses every existing check already reads.
--    Removing content uses deleted_at, which every read already filters on.

create schema companion_admin;
revoke all on schema companion_admin from public, anon, authenticated;
do $$ begin create role companion_admin nologin; exception when duplicate_object then null; end $$;
grant usage on schema companion_admin to companion_admin;

-- ---------- the log ----------

create table companion_private.admin_log (
  id bigint generated always as identity primary key,
  operator text not null default session_user,
  action text not null,
  target_type text not null,
  target_id text not null,
  -- The Owner the action is about, if any. No foreign key: the log outlives the account.
  owner_id uuid,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index admin_log_target on companion_private.admin_log(target_type, target_id, id desc);
create index admin_log_owner on companion_private.admin_log(owner_id, id desc) where owner_id is not null;
alter table companion_private.admin_log enable row level security;
alter table companion_private.admin_log force row level security;
revoke all on companion_private.admin_log from public, anon, authenticated;

-- The model switch log from 0041 becomes part of the one log.
insert into companion_private.admin_log(operator, action, target_type, target_id, reason, detail, created_at)
  select changed_by, 'MODEL_SWITCH', scope, key, coalesce(nullif(btrim(note), ''), '(no reason recorded)'),
    jsonb_build_object('enabled', enabled), changed_at
  from companion_private.model_switch_log order by id;
drop table companion_private.model_switch_log;
drop function companion_private.admin_set_model_switch(text, text, boolean, text);
drop function companion_private.admin_set_chat_quota(integer, bigint);

create trigger admin_log_immutable
before update or delete on companion_private.admin_log
for each row execute function companion_private.reject_immutable_mutation();

-- The reason an operator gave, trimmed; refused when missing or longer than 500 characters.
create function companion_private.admin_reason(p_reason text)
returns text language plpgsql immutable set search_path='' as $$
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception using errcode='22023', message='a reason of 1 to 500 characters is required';
  end if;
  return btrim(p_reason);
end $$;

-- Writes the log row. Raising here undoes the action it belongs to, so nothing happens unlogged.
create function companion_private.admin_note(p_action text, p_target_type text, p_target_id text, p_owner uuid,
  p_reason text, p_detail jsonb default '{}')
returns void language sql set search_path='' as $$
  insert into companion_private.admin_log(action, target_type, target_id, owner_id, reason, detail)
    values (p_action, p_target_type, p_target_id, p_owner, companion_private.admin_reason(p_reason), p_detail)
$$;

-- What a removed post or comment says. Together with deleted_at it marks "removed by an
-- administrator": an Owner's own delete writes '[已删除]' instead.
create function companion_private.admin_removed_text()
returns text language sql immutable set search_path='' as $$ select '[已被管理员移除]' $$;

-- An account as the console shows it: the public card plus who owns it and whether it is suspended.
create function companion_private.admin_actor_json(p_actor uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select companion_private.community_actor_json(a.id) || jsonb_build_object('ownerId', a.owner_id, 'ownerStatus', o.status,
    'twinId', t.id, 'twinStatus', t.status, 'companionId', t.companion_id)
  from public.community_actors a join public.owners o on o.id = a.owner_id
  left join public.social_twins t on t.id = a.social_twin_id
  where a.id = p_actor
$$;

-- ---------- reports: what was done about them ----------

alter table companion_private.community_reports
  add column resolution text check (resolution in ('NONE', 'REMOVED', 'TWIN_SUSPENDED', 'OWNER_SUSPENDED')),
  add column review_note text check (review_note is null or char_length(review_note) <= 500),
  add column reviewed_by text,
  add column reviewed_at timestamptz,
  add constraint community_reports_reviewed check ((status = 'REVIEWED') = (resolution is not null)
    and (status = 'REVIEWED') = (reviewed_by is not null) and (status = 'REVIEWED') = (reviewed_at is not null));
create index community_reports_target on companion_private.community_reports(target_type, target_id);

-- ---------- changes ----------

-- Removes a post or comment from every read. The original text goes to the log.
create function companion_admin.content_remove(p_type text, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_body text; v_actor uuid;
begin
  if p_type = 'POST' then
    select body, actor_id into v_body, v_actor from public.community_posts where id = p_id and deleted_at is null for update;
  elsif p_type = 'COMMENT' then
    select body, actor_id into v_body, v_actor from public.community_comments where id = p_id and deleted_at is null for update;
  else
    raise exception using errcode='22023', message='invalid content type';
  end if;
  if v_actor is null then raise exception using errcode='P0001', message='content not found or already deleted'; end if;
  if p_type = 'POST' then
    update public.community_posts set deleted_at = now(), body = companion_private.admin_removed_text() where id = p_id;
  else
    update public.community_comments set deleted_at = now(), body = companion_private.admin_removed_text() where id = p_id;
  end if;
  perform companion_private.admin_note('REMOVE_' || p_type, p_type, p_id::text,
    (select owner_id from public.community_actors where id = v_actor), p_reason, jsonb_build_object('body', v_body));
  return jsonb_build_object('removed', true);
end $$;

-- Puts back what content_remove took away. Not possible once the author has deleted it themselves.
create function companion_admin.content_restore(p_type text, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_body text; v_actor uuid;
begin
  if p_type = 'POST' then
    select actor_id into v_actor from public.community_posts
      where id = p_id and deleted_at is not null and body = companion_private.admin_removed_text() for update;
  elsif p_type = 'COMMENT' then
    select actor_id into v_actor from public.community_comments
      where id = p_id and deleted_at is not null and body = companion_private.admin_removed_text() for update;
  else
    raise exception using errcode='22023', message='invalid content type';
  end if;
  if v_actor is null then raise exception using errcode='P0001', message='content is not removed by an administrator'; end if;
  select detail->>'body' into v_body from companion_private.admin_log
    where action = 'REMOVE_' || p_type and target_type = p_type and target_id = p_id::text order by id desc limit 1;
  if v_body is null then raise exception using errcode='55000', message='the original text is not in the log'; end if;
  if p_type = 'POST' then
    update public.community_posts set deleted_at = null, body = v_body where id = p_id;
  else
    update public.community_comments set deleted_at = null, body = v_body where id = p_id;
  end if;
  perform companion_private.admin_note('RESTORE_' || p_type, p_type, p_id::text,
    (select owner_id from public.community_actors where id = v_actor), p_reason);
  return jsonb_build_object('restored', true);
end $$;

-- Suspends a Companion's community identity (it cannot post and nobody sees it; private chat goes
-- on), or lifts that and returns it to the status it had before.
create function companion_admin.twin_suspend(p_twin uuid, p_suspend boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.social_twins%rowtype; v_to text;
begin
  if p_suspend is null then raise exception using errcode='22023', message='suspend must be true or false'; end if;
  select * into t from public.social_twins where id = p_twin for update;
  if not found then raise exception using errcode='P0001', message='social twin not found'; end if;
  if p_suspend = (t.status = 'SUSPENDED') then
    raise exception using errcode='55000', message=case when p_suspend then 'already suspended' else 'not suspended' end;
  end if;
  v_to := case when p_suspend then 'SUSPENDED' else coalesce((select detail->>'before' from companion_private.admin_log
    where action = 'SUSPEND_TWIN' and target_type = 'SOCIAL_TWIN' and target_id = t.id::text order by id desc limit 1), 'ACTIVE') end;
  update public.social_twins set status = v_to, updated_at = now() where id = t.id;
  perform companion_private.admin_note(case when p_suspend then 'SUSPEND_TWIN' else 'RESTORE_TWIN' end, 'SOCIAL_TWIN', t.id::text,
    t.owner_id, p_reason, jsonb_build_object('before', t.status));
  return jsonb_build_object('status', v_to);
end $$;

-- Suspends an Owner (every request is refused and none of their accounts is visible), or lifts that.
create function companion_admin.owner_suspend(p_owner uuid, p_suspend boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.owners%rowtype; v_to text;
begin
  if p_suspend is null then raise exception using errcode='22023', message='suspend must be true or false'; end if;
  select * into o from public.owners where id = p_owner for update;
  if not found then raise exception using errcode='P0001', message='owner not found'; end if;
  if o.status = 'DELETED' then raise exception using errcode='55000', message='owner is deleted'; end if;
  if p_suspend = (o.status = 'SUSPENDED') then
    raise exception using errcode='55000', message=case when p_suspend then 'already suspended' else 'not suspended' end;
  end if;
  v_to := case when p_suspend then 'SUSPENDED' else 'ACTIVE' end;
  update public.owners set status = v_to, updated_at = now() where id = o.id;
  perform companion_private.admin_note(case when p_suspend then 'SUSPEND_OWNER' else 'RESTORE_OWNER' end, 'OWNER', o.id::text,
    o.id, p_reason);
  return jsonb_build_object('status', v_to);
end $$;

-- Closes a report with what was done: nothing, the content removed, the Companion's community
-- identity suspended, or the Owner suspended. Every other open report about the same thing is closed
-- with it. A report someone else closed meanwhile is refused, so nothing is done twice. What is
-- already removed or suspended stays so; content its author already deleted cannot be "removed"
-- (close such a report with NONE).
create function companion_admin.report_resolve(p_report uuid, p_resolution text, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r companion_private.community_reports%rowtype; a public.community_actors%rowtype; closed uuid[];
  v_reason text := companion_private.admin_reason(p_reason);
begin
  if p_resolution is null or p_resolution not in ('NONE', 'REMOVED', 'TWIN_SUSPENDED', 'OWNER_SUSPENDED') then
    raise exception using errcode='22023', message='invalid resolution';
  end if;
  select * into r from companion_private.community_reports where id = p_report;
  if not found then raise exception using errcode='P0001', message='report not found'; end if;
  -- Lock every open report about the same thing in one order, then look again.
  perform 1 from companion_private.community_reports
    where target_type = r.target_type and target_id = r.target_id and status = 'SUBMITTED' order by id for update;
  select * into r from companion_private.community_reports where id = p_report;
  if r.status <> 'SUBMITTED' then
    raise exception using errcode='55000', message='report already reviewed by ' || r.reviewed_by;
  end if;
  select * into a from public.community_actors where id = r.target_actor_id;
  if p_resolution = 'REMOVED' then
    if r.target_type = 'ACTOR' then raise exception using errcode='22023', message='a reported account has no content to remove'; end if;
    -- Already removed by an administrator (outside this report): only the report is closed.
    if not exists(
      select 1 from public.community_posts p where r.target_type = 'POST' and p.id = r.target_id
        and p.deleted_at is not null and p.body = companion_private.admin_removed_text()
      union all
      select 1 from public.community_comments c where r.target_type = 'COMMENT' and c.id = r.target_id
        and c.deleted_at is not null and c.body = companion_private.admin_removed_text()) then
      perform companion_admin.content_remove(r.target_type, r.target_id, p_reason);
    end if;
  elsif p_resolution = 'TWIN_SUSPENDED' then
    if a.social_twin_id is null then raise exception using errcode='22023', message='the reported account is a person, not a Companion'; end if;
    if (select status from public.social_twins where id = a.social_twin_id) <> 'SUSPENDED' then
      perform companion_admin.twin_suspend(a.social_twin_id, true, p_reason);
    end if;
  elsif p_resolution = 'OWNER_SUSPENDED' then
    if (select status from public.owners where id = a.owner_id) = 'ACTIVE' then
      perform companion_admin.owner_suspend(a.owner_id, true, p_reason);
    end if;
  end if;
  with done as (
    update companion_private.community_reports
      set status = 'REVIEWED', resolution = p_resolution, review_note = v_reason, reviewed_by = session_user, reviewed_at = now()
      where target_type = r.target_type and target_id = r.target_id and status = 'SUBMITTED' returning id)
  select array_agg(id) into closed from done;
  perform companion_private.admin_note('RESOLVE_REPORT', 'REPORT', r.id::text, a.owner_id, p_reason,
    jsonb_build_object('resolution', p_resolution, 'reports', to_jsonb(closed)));
  return jsonb_build_object('closed', cardinality(closed));
end $$;

-- Turns platform models on or off: everything ('ALL', '*'), one provider, or one model
-- ('<provider>/<model>'). Replaces companion_private.admin_set_model_switch from 0041.
create function companion_admin.model_switch_set(p_scope text, p_key text, p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_before boolean; v_reason text := companion_private.admin_reason(p_reason);
begin
  select enabled into v_before from companion_private.model_switches where scope = p_scope and key = p_key for update;
  insert into companion_private.model_switches(scope, key, enabled, note) values (p_scope, p_key, p_enabled, v_reason)
    on conflict (scope, key) do update set enabled = excluded.enabled, note = excluded.note, updated_at = now();
  perform companion_private.admin_note('MODEL_SWITCH', p_scope, p_key, null, p_reason,
    jsonb_build_object('enabled', p_enabled, 'before', v_before));
end $$;

-- The free daily budget per Companion, for budgets created from now on. Replaces
-- companion_private.admin_set_chat_quota from 0041, which kept no record.
create function companion_admin.chat_quota_set(p_daily_calls integer, p_daily_cost_minor bigint, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare q companion_private.chat_quota%rowtype;
begin
  select * into q from companion_private.chat_quota for update;
  update companion_private.chat_quota set daily_calls = p_daily_calls, daily_cost_minor = p_daily_cost_minor, updated_at = now();
  perform companion_private.admin_note('CHAT_QUOTA', 'CHAT_QUOTA', 'daily', null, p_reason, jsonb_build_object(
    'dailyCalls', p_daily_calls, 'dailyCostMinor', p_daily_cost_minor,
    'before', jsonb_build_object('dailyCalls', q.daily_calls, 'dailyCostMinor', q.daily_cost_minor)));
end $$;

-- ---------- reads ----------

-- The report queue: open reports oldest first, or reviewed ones newest first; 100 at most.
-- `others` is how many more open reports are about the same thing.
create function companion_admin.reports(p_status text default 'SUBMITTED')
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'pending', (select count(*) from companion_private.community_reports where status = 'SUBMITTED'),
    'items', coalesce((select jsonb_agg(q.item order by q.n) from (
      select row_number() over (order by case when r.status = 'SUBMITTED' then r.created_at end, r.reviewed_at desc, r.id) as n,
        jsonb_build_object('id', r.id, 'createdAt', r.created_at, 'reason', r.reason, 'details', r.details,
          'targetType', r.target_type, 'targetId', r.target_id, 'evidence', r.evidence, 'status', r.status,
          'resolution', r.resolution, 'note', r.review_note, 'reviewedBy', r.reviewed_by, 'reviewedAt', r.reviewed_at,
          'reporter', companion_private.admin_actor_json(r.actor_id),
          'target', companion_private.admin_actor_json(r.target_actor_id),
          -- Whether the reported post or comment can still be seen (null for a reported account).
          'live', case r.target_type
            when 'POST' then exists(select 1 from public.community_posts p where p.id = r.target_id and p.deleted_at is null)
            when 'COMMENT' then exists(select 1 from public.community_comments c where c.id = r.target_id and c.deleted_at is null) end,
          'others', (select count(*) from companion_private.community_reports x where x.target_type = r.target_type
            and x.target_id = r.target_id and x.status = 'SUBMITTED' and x.id <> r.id)) as item
      from companion_private.community_reports r where r.status = p_status
      order by 1 limit 100) q), '[]'))
$$;

-- Owners, newest first, 100 at most (`more` says the list was cut: narrow it with a search).
-- The search matches part of the e-mail address or display name, or a whole Owner id.
create function companion_admin.owners(p_search text default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(q.item order by q.n) filter (where q.n <= 100), '[]'),
    'more', count(*) > 100)
  from (
    select row_number() over (order by o.created_at desc, o.id desc) as n,
      jsonb_build_object('id', o.id, 'email', u.email, 'displayName', o.display_name, 'status', o.status, 'createdAt', o.created_at,
        'companions', (select count(*) from public.companions c where c.owner_id = o.id and c.status <> 'DELETED'),
        'posts', (select count(*) from public.community_posts p join public.community_actors a on a.id = p.actor_id
          where a.owner_id = o.id and p.deleted_at is null)) as item
    from public.owners o join auth.users u on u.id = o.auth_user_id
    where coalesce(btrim(p_search), '') = ''
      or strpos(lower(coalesce(u.email, '')), lower(btrim(p_search))) > 0
      or strpos(lower(coalesce(o.display_name, '')), lower(btrim(p_search))) > 0
      or o.id::text = lower(btrim(p_search))
    order by 1 limit 101) q
$$;

-- One Owner: their Companions and their latest 30 posts and 30 comments, deleted ones included.
-- Null when there is no such Owner.
create function companion_admin.owner_detail(p_owner uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'owner', jsonb_build_object('id', o.id, 'email', u.email, 'displayName', o.display_name, 'status', o.status,
      'createdAt', o.created_at),
    'companions', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'displayName', i.display_name,
        'twinId', t.id, 'twinStatus', t.status, 'actorId', a.id) order by c.created_at, c.id)
      from public.companions c left join public.companion_identities i on i.id = c.current_identity_version_id
        left join public.social_twins t on t.companion_id = c.id
        left join public.community_actors a on a.social_twin_id = t.id
      where c.owner_id = o.id), '[]'),
    'posts', coalesce((select jsonb_agg(x.item order by x.created_at desc, x.id desc) from (
      select p.created_at, p.id, jsonb_build_object('id', p.id, 'author', companion_private.community_actor_json(p.actor_id),
        'body', p.body, 'source', p.source, 'createdAt', p.created_at, 'deletedAt', p.deleted_at,
        'removedByAdmin', p.deleted_at is not null and p.body = companion_private.admin_removed_text()) as item
      from public.community_posts p join public.community_actors a on a.id = p.actor_id where a.owner_id = o.id
      order by p.created_at desc, p.id desc limit 30) x), '[]'),
    'comments', coalesce((select jsonb_agg(x.item order by x.created_at desc, x.id desc) from (
      select c.created_at, c.id, jsonb_build_object('id', c.id, 'postId', c.post_id,
        'author', companion_private.community_actor_json(c.actor_id),
        'body', c.body, 'source', c.source, 'createdAt', c.created_at, 'deletedAt', c.deleted_at,
        'removedByAdmin', c.deleted_at is not null and c.body = companion_private.admin_removed_text()) as item
      from public.community_comments c join public.community_actors a on a.id = c.actor_id where a.owner_id = o.id
      order by c.created_at desc, c.id desc limit 30) x), '[]'))
  from public.owners o join auth.users u on u.id = o.auth_user_id where o.id = p_owner
$$;

-- An Owner's chats, without any message text. Reading the messages is chat_read.
create function companion_admin.chats(p_owner uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title,
      'direct', c.direct_companion_id is not null, 'members', companion_private.chat_members_json(c.id),
      'createdAt', c.created_at, 'activeAt', c.active_at,
      'messages', (select count(*) from companion_private.chat_messages m where m.chat_id = c.id and m.status = 'SENT'))
    order by c.active_at desc, c.id desc), '[]'))
  from companion_private.chats c where c.owner_id = p_owner
$$;

-- One page (50, newest first) of a private chat. Every call needs a reason and is logged before
-- anything is returned. Only what still exists can be read: a chat its Owner deleted is gone.
create function companion_admin.chat_read(p_chat uuid, p_reason text, p_before_at timestamptz default null,
  p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; items jsonb; n integer; last_item jsonb;
begin
  if (p_before_at is null) <> (p_before_id is null) then raise exception using errcode='22023', message='invalid cursor'; end if;
  select * into c from companion_private.chats where id = p_chat;
  if not found then raise exception using errcode='P0001', message='chat not found'; end if;
  perform companion_private.admin_note('READ_CHAT', 'CHAT', c.id::text, c.owner_id, p_reason,
    jsonb_build_object('before', p_before_at));
  select coalesce(jsonb_agg(q.item order by q.created_at desc, q.id desc), '[]') into items from (
    select m.created_at, m.id, jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body,
      'status', m.status, 'failure', m.failure, 'createdAt', m.created_at) as item
    from companion_private.chat_messages m
    where m.chat_id = c.id and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))
    order by m.created_at desc, m.id desc limit 51) q;
  n := jsonb_array_length(items);
  if n > 50 then items := items - 50; end if;
  last_item := items->(jsonb_array_length(items) - 1);
  return jsonb_build_object(
    'chat', jsonb_build_object('id', c.id, 'ownerId', c.owner_id, 'title', c.title, 'direct', c.direct_companion_id is not null,
      'members', companion_private.chat_members_json(c.id)),
    'items', items,
    'next', case when n > 50 then jsonb_build_object('at', last_item->'createdAt', 'id', last_item->'id') end);
end $$;

-- What model calls cost from p_from to p_to (UTC days, both included): totals, per day and model,
-- and the 20 Companions that cost most. Money is in minor units (cents for USD), per currency.
-- One call is one ledger transaction that reached an outcome, counted the way the ledger itself
-- reads it: its last SETTLEMENT or RECONCILIATION entry, plus any later corrections. `failed`
-- counts calls that did not succeed (failed, blocked, or closed with the outcome unknown).
create function companion_admin.spend(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path='' as $$
  with entries as (
    select (u.created_at at time zone 'UTC')::date as day, t.provider_id, t.provider_model, t.companion_id, t.owner_id, t.currency,
      1 as calls, (u.status <> 'SUCCEEDED')::int as failed, u.input_tokens, u.output_tokens,
      u.actual_cost_minor + coalesce((select sum(x.cost_delta_minor) from public.compute_ledger_entries x
        where x.transaction_id = t.id and x.entry_type = 'RECONCILIATION' and x.id <> u.id), 0) as cost
    from public.compute_transactions t
    join lateral (select e.* from public.compute_ledger_entries e
      where e.transaction_id = t.id and e.entry_type in ('SETTLEMENT', 'RECONCILIATION')
      order by e.sequence desc limit 1) u on true
    where u.created_at >= p_from::timestamp at time zone 'UTC'
      and u.created_at < (p_to + 1)::timestamp at time zone 'UTC')
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'calls', x.calls, 'costMinor', x.cost)
        order by x.currency)
      from (select currency, sum(calls) as calls, sum(cost) as cost from entries group by currency) x), '[]'),
    'byDay', coalesce((select jsonb_agg(jsonb_build_object('day', x.day, 'provider', x.provider_id, 'model', x.provider_model,
        'currency', x.currency, 'calls', x.calls, 'failed', x.failed, 'inputTokens', x.input_tokens,
        'outputTokens', x.output_tokens, 'costMinor', x.cost) order by x.day desc, x.cost desc, x.provider_id, x.provider_model)
      from (select day, provider_id, provider_model, currency, sum(calls) as calls, sum(failed) as failed,
          sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(cost) as cost
        from entries group by day, provider_id, provider_model, currency) x), '[]'),
    'byCompanion', coalesce((select jsonb_agg(jsonb_build_object('companionId', x.companion_id, 'ownerId', x.owner_id,
        'displayName', (select i.display_name from public.companions c
          join public.companion_identities i on i.id = c.current_identity_version_id where c.id = x.companion_id),
        'currency', x.currency, 'calls', x.calls, 'costMinor', x.cost) order by x.cost desc, x.companion_id)
      from (select companion_id, owner_id, currency, sum(calls) as calls, sum(cost) as cost
        from entries group by companion_id, owner_id, currency order by sum(cost) desc, companion_id limit 20) x), '[]'))
$$;

-- The model switches (anything not listed is on) and the free daily budget per Companion.
create function companion_admin.models()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'switches', coalesce((select jsonb_agg(jsonb_build_object('scope', s.scope, 'key', s.key, 'enabled', s.enabled,
        'note', s.note, 'updatedAt', s.updated_at) order by s.scope, s.key) from companion_private.model_switches s), '[]'),
    'quota', (select jsonb_build_object('dailyCalls', q.daily_calls, 'dailyCostMinor', q.daily_cost_minor,
        'currency', q.currency, 'updatedAt', q.updated_at) from companion_private.chat_quota q))
$$;

-- The log, newest first, 50 per page; optionally only what concerns one Owner.
create function companion_admin.log(p_before bigint default null, p_owner uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(q.item order by q.id desc) filter (where q.n <= 50), '[]'),
    'next', min(q.id) filter (where q.n = 50 and q.total > 50))
  from (
    select l.id, row_number() over (order by l.id desc) as n, count(*) over () as total,
      jsonb_build_object('id', l.id, 'operator', l.operator, 'action', l.action, 'targetType', l.target_type,
        'targetId', l.target_id, 'ownerId', l.owner_id, 'reason', l.reason, 'detail', l.detail, 'createdAt', l.created_at) as item
    from companion_private.admin_log l
    where (p_before is null or l.id < p_before) and (p_owner is null or l.owner_id = p_owner)
    order by l.id desc limit 51) q
$$;

revoke execute on all functions in schema companion_admin from public, anon, authenticated;
grant execute on all functions in schema companion_admin to companion_admin;
revoke execute on function companion_private.admin_reason(text), companion_private.admin_note(text, text, text, uuid, text, jsonb),
  companion_private.admin_removed_text(), companion_private.admin_actor_json(uuid) from public, anon, authenticated;

commit;
