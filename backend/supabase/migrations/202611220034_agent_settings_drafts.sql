begin;

-- What an AI Companion may do on its own, set by its Owner. One row per AI community actor,
-- created with these defaults on first use. The Owner posting by hand is not limited by it.
-- auto_enabled and interval_minutes are stored for the Owner's settings screen; scheduled
-- activity that reads them comes later.
create table companion_private.agent_settings (
  actor_id uuid primary key references public.community_actors(id),
  paused boolean not null default false,
  auto_enabled boolean not null default false,
  interval_minutes integer not null default 180 check (interval_minutes between 15 and 1440),
  active_from time not null default '09:00',
  active_to time not null default '23:00',
  time_zone text not null default 'Asia/Shanghai',
  can_post boolean not null default false,
  can_comment boolean not null default true,
  publish_mode text not null default 'DRAFT' check (publish_mode in ('DRAFT', 'DIRECT')),
  daily_posts integer not null default 3 check (daily_posts between 0 and 30),
  daily_comments integer not null default 10 check (daily_comments between 0 and 100),
  comments_per_post integer not null default 3 check (comments_per_post between 1 and 10),
  revision integer not null default 1 check (revision >= 1)
);

-- AI-written text waiting for the Owner. Decided drafts are kept (not deleted) so a retry with
-- the same key still finds its outcome. Publishing runs community_command with the draft's own
-- key, so every community rule is checked again and the published item is the key's replay.
create table companion_private.agent_drafts (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.community_actors(id),
  post_id uuid references public.community_posts(id), -- null: a new post; otherwise a comment on this post
  body text not null check (char_length(body) between 1 and 4000),
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'PUBLISHED', 'DISCARDED')),
  created_at timestamptz not null default now(),
  unique (actor_id, key_hash)
);
create index agent_drafts_pending on companion_private.agent_drafts(actor_id, created_at desc) where status = 'PENDING';

alter table companion_private.agent_settings enable row level security;
alter table companion_private.agent_settings force row level security;
alter table companion_private.agent_drafts enable row level security;
alter table companion_private.agent_drafts force row level security;
revoke all on companion_private.agent_settings, companion_private.agent_drafts from public, anon, authenticated;

-- The settings row of the caller's own AI actor. Rejects human actors and foreign Companions.
create function companion_private.agent_settings_for(p_kind text, p_id uuid)
returns companion_private.agent_settings language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; s companion_private.agent_settings%rowtype;
begin
  a := companion_private.community_actor(p_kind, p_id);
  if a.kind <> 'AI' then raise exception using errcode='42501', message='agent settings need a Companion actor'; end if;
  insert into companion_private.agent_settings(actor_id) values (a.id) on conflict do nothing;
  select * into s from companion_private.agent_settings where actor_id = a.id;
  return s;
end $$;

-- Lock order shared with community_command: the actor pair first, then the actor row.
-- Returns the settings re-read under the lock, so a queued command sees the latest settings.
create function companion_private.agent_lock(s companion_private.agent_settings, p_post uuid)
returns companion_private.agent_settings language plpgsql security definer set search_path='' as $$
declare author uuid; locked companion_private.agent_settings%rowtype;
begin
  select actor_id into author from public.community_posts where id = p_post;
  if author is not null then perform companion_private.community_lock_pair(s.actor_id, author); end if;
  perform 1 from public.community_actors where id = s.actor_id for update;
  select * into locked from companion_private.agent_settings where actor_id = s.actor_id;
  return locked;
end $$;

-- Settings, the Owner's local time, and what was used today in that time zone. Drafts not yet
-- published count too (a published draft is counted as the post or comment it became).
create function companion_private.agent_settings_json(s companion_private.agent_settings)
returns jsonb language sql stable security definer set search_path='' as $$
  with day as (select date_trunc('day', now() at time zone s.time_zone) at time zone s.time_zone as start)
  select jsonb_build_object(
    'paused', s.paused, 'autoEnabled', s.auto_enabled, 'intervalMinutes', s.interval_minutes,
    'activeFrom', to_char(s.active_from, 'HH24:MI'), 'activeTo', to_char(s.active_to, 'HH24:MI'),
    'timeZone', s.time_zone, 'canPost', s.can_post, 'canComment', s.can_comment,
    'publishMode', s.publish_mode, 'dailyPosts', s.daily_posts, 'dailyComments', s.daily_comments,
    'commentsPerPost', s.comments_per_post, 'revision', s.revision,
    'localTime', to_char(now() at time zone s.time_zone, 'FMMM/FMDD HH24:MI'),
    'usage', jsonb_build_object(
      'postsToday', (select count(*) from public.community_posts where actor_id = s.actor_id and created_at >= day.start)
        + (select count(*) from companion_private.agent_drafts where actor_id = s.actor_id and post_id is null
           and status <> 'PUBLISHED' and created_at >= day.start),
      'commentsToday', (select count(*) from public.community_comments where actor_id = s.actor_id and created_at >= day.start)
        + (select count(*) from companion_private.agent_drafts where actor_id = s.actor_id and post_id is not null
           and status <> 'PUBLISHED' and created_at >= day.start)))
  from day
$$;

create function public.agent_get_settings(p_kind text, p_id uuid)
returns jsonb language sql security definer set search_path='' as $$
  select companion_private.agent_settings_json(companion_private.agent_settings_for(p_kind, p_id))
$$;

-- Replaces every setting at once. A stale revision (another device saved first) is a conflict.
create function public.agent_update_settings(p_kind text, p_id uuid, p_settings jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.agent_settings%rowtype; owner uuid;
begin
  s := companion_private.agent_settings_for(p_kind, p_id);
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_settings->>'timeZone') then
    raise exception using errcode='22023', message='unknown time zone';
  end if;
  update companion_private.agent_settings set
    paused = (p_settings->>'paused')::boolean,
    auto_enabled = (p_settings->>'autoEnabled')::boolean,
    interval_minutes = (p_settings->>'intervalMinutes')::integer,
    active_from = (p_settings->>'activeFrom')::time,
    active_to = (p_settings->>'activeTo')::time,
    time_zone = p_settings->>'timeZone',
    can_post = (p_settings->>'canPost')::boolean,
    can_comment = (p_settings->>'canComment')::boolean,
    publish_mode = p_settings->>'publishMode',
    daily_posts = (p_settings->>'dailyPosts')::integer,
    daily_comments = (p_settings->>'dailyComments')::integer,
    comments_per_post = (p_settings->>'commentsPerPost')::integer,
    revision = revision + 1
  where actor_id = s.actor_id and revision = (p_settings->>'revision')::integer
  returning * into s;
  if not found then raise exception using errcode='23505', message='agent settings revision conflict'; end if;
  select owner_id into owner from public.community_actors where id = s.actor_id;
  insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
    values (owner, 'OWNER', owner, 'AGENT_UPDATE_SETTINGS', 'COMMUNITY_ACTOR', s.actor_id);
  return companion_private.agent_settings_json(s);
end $$;

-- A post or comment written by the AI. Returns one of:
--   {"status":"PUBLISHED","item":<post or comment>}  publish mode DIRECT, or a draft the Owner published
--   {"status":"DRAFT","draftId":...}                  publish mode DRAFT, waiting for the Owner
--   {"status":"DISCARDED"}                            the Owner discarded this draft
--   {"status":"REFUSED","reason":...,"settings":...}  PAUSED | NOT_ALLOWED | OUTSIDE_HOURS | DAILY_LIMIT | POST_LIMIT
-- A retry with the same key returns the first outcome, even if a limit was reached since.
create function public.agent_command(p_kind text, p_id uuid, p_action text, p_target uuid, p_body text, p_key text, p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.agent_settings%rowtype; d companion_private.agent_drafts%rowtype;
  v_view jsonb; t time; reason text;
  v_body text := btrim(p_body); v_target uuid := case when p_action = 'COMMENT' then p_target end;
begin
  s := companion_private.agent_settings_for(p_kind, p_id);
  if p_action is null or p_action not in ('POST', 'COMMENT') or p_key is null or p_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023', message='invalid agent command';
  end if;
  s := companion_private.agent_lock(s, v_target);

  select * into d from companion_private.agent_drafts where actor_id = s.actor_id and key_hash = p_key;
  if found then
    if d.body is distinct from v_body or d.post_id is distinct from v_target then
      raise exception using errcode='23505', message='idempotency conflict';
    end if;
    if d.status = 'DISCARDED' then return jsonb_build_object('status', 'DISCARDED'); end if;
    if d.status = 'PENDING' then return jsonb_build_object('status', 'DRAFT', 'draftId', d.id); end if;
  end if;
  -- Published before (directly, or as a draft the Owner published): community_command replays it.
  if d.status = 'PUBLISHED' or exists (select 1 from companion_private.community_requests where actor_id = s.actor_id and key_hash = p_key) then
    return jsonb_build_object('status', 'PUBLISHED', 'item', public.community_command(p_kind, p_id, p_action, v_target, v_body, p_key, p_hash));
  end if;

  v_view := companion_private.agent_settings_json(s);
  t := (now() at time zone s.time_zone)::time;
  reason := case
    when s.paused then 'PAUSED'
    when (p_action = 'POST' and not s.can_post) or (p_action = 'COMMENT' and not s.can_comment) then 'NOT_ALLOWED'
    when s.active_from < s.active_to and not (t >= s.active_from and t < s.active_to) then 'OUTSIDE_HOURS'
    when s.active_from > s.active_to and not (t >= s.active_from or t < s.active_to) then 'OUTSIDE_HOURS'
    when p_action = 'POST' and (v_view->'usage'->>'postsToday')::integer >= s.daily_posts then 'DAILY_LIMIT'
    when p_action = 'COMMENT' and (v_view->'usage'->>'commentsToday')::integer >= s.daily_comments then 'DAILY_LIMIT'
    when p_action = 'COMMENT' and
      (select count(*) from public.community_comments where actor_id = s.actor_id and post_id = v_target)
      + (select count(*) from companion_private.agent_drafts where actor_id = s.actor_id and post_id = v_target and status <> 'PUBLISHED')
      >= s.comments_per_post then 'POST_LIMIT'
  end;
  if reason is not null then return jsonb_build_object('status', 'REFUSED', 'reason', reason, 'settings', v_view); end if;

  if s.publish_mode = 'DIRECT' then
    return jsonb_build_object('status', 'PUBLISHED', 'item', public.community_command(p_kind, p_id, p_action, v_target, v_body, p_key, p_hash));
  end if;
  -- Refuse now what publishing would refuse for certain, so the Owner is not asked to approve
  -- something impossible. Hourly limits and later deletions are checked again on publish.
  if v_body is null or char_length(v_body) < 1 or char_length(v_body) > (case when p_action = 'POST' then 4000 else 2000 end) then
    raise exception using errcode='22023', message='invalid text';
  end if;
  if not exists (select 1 from public.community_actors ca
    join public.social_twins tw on tw.id = ca.social_twin_id
    join public.social_personas sp on sp.id = tw.active_social_persona_id
    join public.companions c on c.id = tw.companion_id
    where ca.id = s.actor_id and tw.status = 'ACTIVE' and c.status = 'ACTIVE' and sp.profile_visibility = 'PUBLIC') then
    raise exception using errcode='42501', message='public social identity is not active';
  end if;
  if p_action = 'COMMENT' and not exists (select 1 from public.community_posts p where p.id = v_target
    and p.deleted_at is null and companion_private.community_visible(p.actor_id, s.actor_id)) then
    raise exception using errcode='P0001', message='post not found';
  end if;
  insert into companion_private.agent_drafts(actor_id, post_id, body, key_hash) values (s.actor_id, v_target, v_body, p_key)
    returning * into d;
  return jsonb_build_object('status', 'DRAFT', 'draftId', d.id);
end $$;

create function public.agent_list_drafts(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.agent_settings%rowtype;
begin
  s := companion_private.agent_settings_for(p_kind, p_id);
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'kind', case when d.post_id is null then 'POST' else 'COMMENT' end,
      'postId', d.post_id, 'body', d.body, 'createdAt', d.created_at) order by d.created_at desc, d.id desc)
    from (select * from companion_private.agent_drafts where actor_id = s.actor_id and status = 'PENDING'
          order by created_at desc, id desc limit 50) d), '[]'));
end $$;

-- The Owner publishes or discards one pending draft. Publishing goes through community_command
-- with the draft's own key, so blocks, deleted posts and hourly limits are checked again now.
create function public.agent_decide_draft(p_kind text, p_id uuid, p_draft uuid, p_publish boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.agent_settings%rowtype; d companion_private.agent_drafts%rowtype; item jsonb;
begin
  s := companion_private.agent_settings_for(p_kind, p_id);
  s := companion_private.agent_lock(s, (select post_id from companion_private.agent_drafts where id = p_draft and actor_id = s.actor_id));
  select * into d from companion_private.agent_drafts where id = p_draft and actor_id = s.actor_id and status = 'PENDING';
  if not found then raise exception using errcode='P0001', message='draft not found'; end if;
  if not p_publish then
    update companion_private.agent_drafts set status = 'DISCARDED' where id = d.id;
    return jsonb_build_object('discarded', true);
  end if;
  item := public.community_command(p_kind, p_id, case when d.post_id is null then 'POST' else 'COMMENT' end,
    d.post_id, d.body, d.key_hash, d.key_hash);
  update companion_private.agent_drafts set status = 'PUBLISHED' where id = d.id;
  return jsonb_build_object('published', item);
end $$;

revoke all on function companion_private.agent_settings_for(text, uuid),
  companion_private.agent_lock(companion_private.agent_settings, uuid),
  companion_private.agent_settings_json(companion_private.agent_settings) from public, anon, authenticated;
revoke all on function public.agent_get_settings(text, uuid), public.agent_update_settings(text, uuid, jsonb),
  public.agent_command(text, uuid, text, uuid, text, text, text), public.agent_list_drafts(text, uuid),
  public.agent_decide_draft(text, uuid, uuid, boolean) from public, anon;
grant execute on function public.agent_get_settings(text, uuid), public.agent_update_settings(text, uuid, jsonb),
  public.agent_command(text, uuid, text, uuid, text, text, text), public.agent_list_drafts(text, uuid),
  public.agent_decide_draft(text, uuid, uuid, boolean) to authenticated;

commit;
