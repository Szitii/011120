begin;

-- What the new four-tab app needs from the server (docs/FRONTEND_BACKEND_HANDOFF.md, items 1 and 2):
--   * chat read state: how far the Owner has read each chat, so unread counts survive a device change;
--   * Owner notifications that point somewhere: a Companion's draft waiting for review is now one;
--   * one call for every badge (chats, Owner notifications, community notifications per identity);
--   * the follower list says whether the viewer follows each one back;
--   * the anniversary date of a Companion (相伴起始日), kept on the server.

-- ---------- chat read state ----------

-- How far one reader has read one chat: the (shown_at, id) of the last message read. Only moves
-- forward. Keyed by reader so other people can join chats later without changing this table.
create table companion_private.chat_reads (
  chat_id uuid not null references companion_private.chats(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  read_at timestamptz not null,
  read_id uuid not null,
  primary key (chat_id, owner_id)
);
alter table companion_private.chat_reads enable row level security;
alter table companion_private.chat_reads force row level security;
revoke all on companion_private.chat_reads from public, anon, authenticated;

-- Companion messages shown after the Owner's read position (their own messages and actions never count).
create function companion_private.chat_unread(c companion_private.chats)
returns integer language sql stable security definer set search_path='' as $$
  select count(*)::integer from companion_private.chat_messages x
  where x.chat_id = c.id and x.companion_id is not null and x.status in ('SENT', 'FAILED', 'BLOCKED') and x.shown_at <= now()
    and not exists(select 1 from companion_private.chat_reads r where r.chat_id = c.id and r.owner_id = c.owner_id
      and (x.shown_at, x.id) <= (r.read_at, r.read_id))
$$;

-- Same as in 0040, plus unreadCount and readUpTo (the last message read, or null).
create or replace function companion_private.chat_json(c companion_private.chats)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', c.id, 'title', c.title, 'direct', c.direct_companion_id is not null,
    'members', companion_private.chat_members_json(c.id),
    'lastMessage', (select companion_private.chat_message_json(x) from companion_private.chat_messages x
      where x.chat_id = c.id and x.status in ('SENT', 'FAILED', 'BLOCKED') and x.shown_at <= now()
      order by x.shown_at desc, x.id desc limit 1),
    'unreadCount', companion_private.chat_unread(c),
    'readUpTo', (select r.read_id from companion_private.chat_reads r where r.chat_id = c.id and r.owner_id = c.owner_id),
    'activeAt', c.active_at) || companion_private.chat_progress(c)
$$;

-- Same as in 0040, plus unreadTotal over every chat.
create or replace function public.chat_list()
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(companion_private.chat_json(c) order by c.active_at desc, c.id desc), '[]'),
    'unreadTotal', coalesce(sum(companion_private.chat_unread(c)), 0))
  from companion_private.chats c where c.owner_id = companion_private.chat_owner()
$$;

-- The Owner has read up to p_message (a shown message of the chat). An older position than the
-- saved one changes nothing, so devices can report in any order. Returns the chat.
create function public.chat_mark_read(p_chat uuid, p_message uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype;
begin
  select * into c from companion_private.chats where id = p_chat and owner_id = companion_private.chat_owner();
  if not found then raise exception using errcode='P0001', message='chat not found'; end if;
  select * into m from companion_private.chat_messages
  where id = p_message and chat_id = c.id and status in ('SENT', 'FAILED', 'BLOCKED') and shown_at <= now();
  if not found then raise exception using errcode='P0001', message='message not found'; end if;
  insert into companion_private.chat_reads as r (chat_id, owner_id, read_at, read_id) values (c.id, c.owner_id, m.shown_at, m.id)
  on conflict (chat_id, owner_id) do update set read_at = excluded.read_at, read_id = excluded.read_id
    where (excluded.read_at, excluded.read_id) > (r.read_at, r.read_id);
  return companion_private.chat_json(c);
end $$;

-- ---------- Owner notifications with a target ----------

-- An item now says what it is about (kind) and where tapping it goes. LIFE_EVENT items keep their
-- life_event_id; other kinds point at target_id: AGENT_DRAFT a Companion's draft waiting for review.
alter table public.life_event_inbox alter column life_event_id drop not null;
alter table public.life_event_inbox add column kind text not null default 'LIFE_EVENT' check (kind in ('LIFE_EVENT', 'AGENT_DRAFT'));
alter table public.life_event_inbox add column target_id uuid;
alter table public.life_event_inbox add constraint life_event_inbox_kind_target
  check ((kind = 'LIFE_EVENT') = (life_event_id is not null) and (kind = 'LIFE_EVENT') = (target_id is null));
create unique index life_event_inbox_target on public.life_event_inbox(kind, target_id) where target_id is not null;
create index life_event_inbox_unread on public.life_event_inbox(owner_id) where read_at is null;

create function companion_private.owner_notice_json(i public.life_event_inbox)
returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('id', i.id, 'kind', i.kind, 'lifeEventId', i.life_event_id,
    'companionId', i.companion_id, 'title', i.title, 'createdAt', i.created_at, 'readAt', i.read_at,
    'linkedObject', jsonb_build_object('type', i.kind, 'id', coalesce(i.target_id, i.life_event_id))))
$$;

-- Same paging as in 0020; items carry kind and the target.
create or replace function public.list_life_event_inbox(
  p_limit integer default 20,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
) returns table(item jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_limit<1 or p_limit>50 or ((p_before_created_at is null)<>(p_before_id is null)) then
    raise exception using errcode='22023',message='invalid Life Event Inbox page';
  end if;
  return query
  select companion_private.owner_notice_json(inbox)
  from public.life_event_inbox inbox
  where inbox.owner_id=actor.id
    and (p_before_created_at is null or (inbox.created_at,inbox.id)<(p_before_created_at,p_before_id))
  order by inbox.created_at desc,inbox.id desc
  limit p_limit;
end $$;

create or replace function public.ack_life_event_inbox_item(p_item_id uuid)
returns table(item jsonb)
language plpgsql security definer set search_path='' as $$
declare actor public.owners%rowtype; inbox public.life_event_inbox%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  update public.life_event_inbox set read_at=coalesce(read_at,statement_timestamp())
    where id=p_item_id and owner_id=actor.id returning * into inbox;
  if not found then return; end if;
  return query select companion_private.owner_notice_json(inbox);
end $$;

-- A Companion's new draft tells its Owner; once the Owner publishes or discards it, the notice is read.
create function companion_private.agent_draft_notice()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op = 'INSERT' and new.status = 'PENDING' then
    insert into public.life_event_inbox(owner_id, companion_id, kind, target_id, title)
    select a.owner_id, t.companion_id, 'AGENT_DRAFT', new.id,
      case when new.post_id is null then '写了一条动态，等你审核' else '写了一条评论，等你审核' end
    from public.community_actors a join public.social_twins t on t.id = a.social_twin_id
    where a.id = new.actor_id;
  elsif tg_op = 'UPDATE' and old.status = 'PENDING' and new.status <> 'PENDING' then
    update public.life_event_inbox set read_at = coalesce(read_at, now()) where kind = 'AGENT_DRAFT' and target_id = new.id;
  end if;
  return null;
end $$;
create trigger agent_drafts_notice after insert or update of status on companion_private.agent_drafts
  for each row execute function companion_private.agent_draft_notice();

insert into public.life_event_inbox(owner_id, companion_id, kind, target_id, title, created_at)
select a.owner_id, t.companion_id, 'AGENT_DRAFT', d.id,
  case when d.post_id is null then '写了一条动态，等你审核' else '写了一条评论，等你审核' end, d.created_at
from companion_private.agent_drafts d
join public.community_actors a on a.id = d.actor_id join public.social_twins t on t.id = a.social_twin_id
where d.status = 'PENDING';

-- ---------- badges ----------

-- The same rule GET /v0/community/notifications uses to show a notification (0032).
create function companion_private.community_notice_shown(nt public.community_notifications)
returns boolean language sql stable security definer set search_path='' as $$
  select companion_private.community_visible(nt.actor_id, nt.recipient_id)
    and (nt.kind = 'FOLLOW' and exists(select 1 from public.community_follows f where f.actor_id = nt.actor_id and f.target_id = nt.recipient_id)
      or nt.kind = 'COMMENT' and exists(select 1 from public.community_posts p join public.community_comments c on c.post_id = p.id
        where p.id = nt.post_id and c.id = nt.comment_id and p.deleted_at is null and c.deleted_at is null
          and companion_private.community_visible(p.actor_id, nt.recipient_id)))
$$;

-- Every unread count in one call: chats, Owner notifications, and community notifications for
-- each identity the Owner can act as (the Owner, and each Companion that has been in the community).
create function public.home_badges()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  return jsonb_build_object(
    'chats', (select coalesce(sum(companion_private.chat_unread(c)), 0) from companion_private.chats c where c.owner_id = o),
    'ownerInbox', (select count(*) from public.life_event_inbox where owner_id = o and read_at is null),
    'community', coalesce((select jsonb_agg(jsonb_build_object(
        'actorKind', case when a.kind = 'HUMAN' then 'OWNER' else 'COMPANION' end,
        'actorId', coalesce(t.companion_id, a.owner_id),
        'unread', (select count(*) from public.community_notifications nt
          where nt.recipient_id = a.id and nt.read_at is null and companion_private.community_notice_shown(nt)))
      order by a.kind desc, a.created_at, a.id)
      from public.community_actors a
      left join public.social_twins t on t.id = a.social_twin_id
      left join public.companions co on co.id = t.companion_id
      where a.owner_id = o and (a.kind = 'HUMAN' or (t.status <> 'SUSPENDED' and co.status not in ('DELETED', 'QUARANTINED')))), '[]'));
end $$;

-- ---------- follow-back flag ----------

-- Same as in 0034, plus `following`: whether the viewing identity follows this one (for 回关 in the followers list).
create or replace function public.community_follow_list(p_kind text, p_id uuid, p_direction text,
  p_before_at timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; items jsonb; n integer; last_item jsonb;
begin
  a := companion_private.community_actor(p_kind, p_id);
  if p_direction is null or p_direction not in ('FOLLOWING', 'FOLLOWERS') or ((p_before_at is null) <> (p_before_id is null)) then
    raise exception using errcode='22023', message='invalid follow list';
  end if;
  select coalesce(jsonb_agg(q.item order by q.created_at desc, q.other desc), '[]') into items from (
    select f.created_at, x.other, jsonb_build_object('actor', companion_private.community_actor_json(x.other),
      'since', f.created_at,
      'following', exists(select 1 from public.community_follows g where g.actor_id = a.id and g.target_id = x.other)) item
    from public.community_follows f
    cross join lateral (select case when p_direction = 'FOLLOWING' then f.target_id else f.actor_id end as other) x
    where (case when p_direction = 'FOLLOWING' then f.actor_id else f.target_id end) = a.id
      and companion_private.community_visible(x.other, a.id)
      and (p_before_at is null or (f.created_at, x.other) < (p_before_at, p_before_id))
    order by f.created_at desc, x.other desc limit 21) q;
  n := jsonb_array_length(items);
  if n > 20 then items := items - 20; end if;
  last_item := items->(jsonb_array_length(items) - 1);
  return jsonb_build_object('items', items, 'nextCursor',
    case when n > 20 then (last_item->>'since') || '|' || (last_item->'actor'->>'id') end);
end $$;

-- ---------- anniversary (相伴起始日) ----------

-- One date per Companion, set by its Owner; null when not set. The day it counts from is a calendar
-- date in time_zone, and may be long before the account existed. The app counts the days.
create table companion_private.anniversaries (
  companion_id uuid primary key references public.companions(id) on delete cascade,
  start_date date check (start_date >= date '1900-01-01'),
  time_zone text not null default 'Asia/Shanghai',
  revision integer not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now()
);
alter table companion_private.anniversaries enable row level security;
alter table companion_private.anniversaries force row level security;
revoke all on companion_private.anniversaries from public, anon, authenticated;

create function companion_private.anniversary_for(p_companion uuid)
returns companion_private.anniversaries language plpgsql security definer set search_path='' as $$
declare s companion_private.anniversaries%rowtype;
begin
  if not companion_private.chat_companion_ok(companion_private.chat_owner(), p_companion) then
    raise exception using errcode='P0001', message='companion not found';
  end if;
  insert into companion_private.anniversaries(companion_id) values (p_companion) on conflict do nothing;
  select * into s from companion_private.anniversaries where companion_id = p_companion for update;
  return s;
end $$;

create function companion_private.anniversary_json(s companion_private.anniversaries)
returns jsonb language sql immutable as $$
  select jsonb_build_object('companionId', s.companion_id, 'startDate', to_char(s.start_date, 'YYYY-MM-DD'),
    'timeZone', s.time_zone, 'revision', s.revision, 'updatedAt', s.updated_at)
$$;

create function public.anniversary_get(p_companion uuid)
returns jsonb language sql security definer set search_path='' as $$
  select companion_private.anniversary_json(companion_private.anniversary_for(p_companion))
$$;

-- Set (p_start a date) or clear (null) the date. Not after today in p_time_zone. A stale revision
-- (another device saved first) is a conflict.
create function public.anniversary_save(p_companion uuid, p_start date, p_time_zone text, p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.anniversaries%rowtype; o uuid := companion_private.chat_owner();
begin
  if p_time_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name = p_time_zone)
    or p_start < date '1900-01-01' or p_start > (now() at time zone p_time_zone)::date then
    raise exception using errcode='22023', message='invalid anniversary';
  end if;
  s := companion_private.anniversary_for(p_companion);
  update companion_private.anniversaries set start_date = p_start, time_zone = p_time_zone, revision = revision + 1, updated_at = now()
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='anniversary revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'ANNIVERSARY_UPDATE', 'COMPANION', s.companion_id);
  return companion_private.anniversary_json(s);
end $$;

-- ---------- grants ----------

revoke all on function companion_private.chat_unread(companion_private.chats),
  companion_private.owner_notice_json(public.life_event_inbox), companion_private.agent_draft_notice(),
  companion_private.community_notice_shown(public.community_notifications),
  companion_private.anniversary_for(uuid), companion_private.anniversary_json(companion_private.anniversaries)
  from public, anon, authenticated;
revoke all on function public.chat_mark_read(uuid, uuid), public.home_badges(), public.anniversary_get(uuid),
  public.anniversary_save(uuid, date, text, integer) from public, anon, authenticated;
grant execute on function public.chat_mark_read(uuid, uuid), public.home_badges(), public.anniversary_get(uuid),
  public.anniversary_save(uuid, date, text, integer) to authenticated;

commit;
