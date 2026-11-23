begin;

-- Chat between an Owner and their own Companions: one Companion, or a group of up to 8.
--
-- Private by structure: the tables live in companion_private with no grants, and are reached
-- only through the chat_* functions below, which resolve the signed-in Owner on every call.
-- No community function reads them, so chat text cannot reach a public post or comment.
-- Letting other people into a chat is a later step (a member kind on chat_members).
--
-- Who answers is decided here, not by the client or the AI (hard limits); how talkative a
-- Companion is inside those limits is left to the model (soft tendency, via `optional`):
--   * the Owner speaks: in a one-to-one chat the Companion must answer. In a group the
--     @mentioned Companions must answer; with no mention, group_activity decides: ACTIVE must
--     answer, NORMAL may answer (the model decides whether it concerns it), QUIET stays quiet;
--   * a Companion speaks: when nobody else is waiting, one other Companion may answer it, at
--     most 0/1/2/4 times per Owner message (companion_interaction NONE/RARE/NORMAL/LIVELY);
--   * after one Owner message at most 8 Companion turns are shown and 16 attempted, then the
--     chat waits for the Owner. A new Owner message drops the queued replies to Companions.
--
-- Pacing, so a reply does not appear the instant the Owner sends: a Companion that must answer
-- starts "typing" 1-3 s after the message (it read it); one that may answer shows nothing until
-- it decided to speak. A reply of 1 to 3 short messages is typed one after another, each for a
-- time that grows with its length (1-6 s), after the previous Companion message appeared. If
-- the model is slower than that, the message appears as soon as it is ready. Every duration is
-- multiplied by the setting companion.chat_pace (default 1; tests set it lower).
--
-- Replies are produced by the API server one at a time per chat (chat_claim / chat_finish,
-- granted to companion_api only), so each Companion sees the replies before its own.

create table companion_private.chats (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  title text check (title is null or char_length(title) between 1 and 40),
  -- Set only for a one-to-one chat; each Companion has exactly one.
  direct_companion_id uuid references public.companions(id) on delete cascade,
  -- The Owner's retry key for creating a group, so a retried request does not make a second group.
  key_hash text check (key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  active_at timestamptz not null default now(),
  check (direct_companion_id is null or (title is null and key_hash is null))
);
create unique index chats_direct on companion_private.chats(direct_companion_id) where direct_companion_id is not null;
create unique index chats_key on companion_private.chats(owner_id, key_hash) where key_hash is not null;
create index chats_owner on companion_private.chats(owner_id, active_at desc, id desc);

create table companion_private.chat_members (
  chat_id uuid not null references companion_private.chats(id) on delete cascade,
  companion_id uuid not null references public.companions(id) on delete cascade,
  position smallint not null check (position between 1 and 8),
  primary key (chat_id, companion_id),
  unique (chat_id, position)
);

-- companion_id null: the Owner wrote it. A Companion's turn starts as one PENDING row and ends
-- SENT (1 to 3 rows, part 1..3), FAILED (failure says why), BLOCKED (stopped by the safety scan)
-- or PASSED (an optional turn the Companion let go; never shown). typing_at..shown_at is when
-- "typing" shows for a SENT row; the Owner sees a row once shown_at has passed.
create table companion_private.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references companion_private.chats(id) on delete cascade,
  companion_id uuid references public.companions(id) on delete cascade,
  body text check (body is null or char_length(body) between 1 and 2000),
  mentions uuid[] not null default '{}',
  status text not null check (status in ('SENT', 'PENDING', 'FAILED', 'BLOCKED', 'PASSED')),
  reply_to text check (reply_to in ('OWNER', 'COMPANION')),
  optional boolean not null default false,
  part smallint not null default 1 check (part between 1 and 3),
  failure text check (failure in ('UNAVAILABLE', 'ERROR')),
  key_hash text check (key_hash ~ '^[a-f0-9]{64}$'),
  claim_id uuid,
  claimed_at timestamptz,
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  typing_at timestamptz,
  shown_at timestamptz,
  check ((companion_id is null) = (reply_to is null)),
  check ((companion_id is null) = (key_hash is not null)),
  check (companion_id is not null or not optional),
  check ((status = 'SENT') = (body is not null)),
  check ((status = 'PENDING') = (shown_at is null)),
  check ((status = 'FAILED') = (failure is not null)),
  check (status <> 'PASSED' or optional),
  check (typing_at is null or shown_at is null or typing_at <= shown_at),
  unique (chat_id, key_hash)
);
create index chat_messages_chat on companion_private.chat_messages(chat_id, shown_at desc, id desc);
create index chat_messages_owner_rate on companion_private.chat_messages(created_at) where companion_id is null;

-- How a Companion takes part in group chats, set by its Owner. Created with defaults on first use.
create table companion_private.chat_settings (
  companion_id uuid primary key references public.companions(id) on delete cascade,
  group_activity text not null default 'NORMAL' check (group_activity in ('QUIET', 'NORMAL', 'ACTIVE')),
  companion_interaction text not null default 'NORMAL' check (companion_interaction in ('NONE', 'RARE', 'NORMAL', 'LIVELY')),
  revision integer not null default 1 check (revision >= 1)
);

alter table companion_private.chats enable row level security;
alter table companion_private.chats force row level security;
alter table companion_private.chat_members enable row level security;
alter table companion_private.chat_members force row level security;
alter table companion_private.chat_messages enable row level security;
alter table companion_private.chat_messages force row level security;
alter table companion_private.chat_settings enable row level security;
alter table companion_private.chat_settings force row level security;
revoke all on companion_private.chats, companion_private.chat_members, companion_private.chat_messages,
  companion_private.chat_settings from public, anon, authenticated;

-- ---------- helpers ----------

create function companion_private.chat_owner()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare o uuid;
begin
  select id into o from public.owners where auth_user_id = (select auth.uid()) and status = 'ACTIVE';
  if o is null then raise exception using errcode='42501', message='authentication required'; end if;
  return o;
end $$;

-- The signed-in Owner's chat, locked so sends, claims and finishes in one chat run one at a time.
create function companion_private.chat_for(p_chat uuid)
returns companion_private.chats language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype;
begin
  select * into c from companion_private.chats where id = p_chat and owner_id = companion_private.chat_owner() for update;
  if not found then raise exception using errcode='P0001', message='chat not found'; end if;
  return c;
end $$;

-- A Companion that can take part: the Owner's own, not deleted or quarantined, with an identity.
create function companion_private.chat_companion_ok(p_owner uuid, p_companion uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.companions c where c.id = p_companion and c.owner_id = p_owner
    and c.status not in ('DELETED', 'QUARANTINED') and c.current_identity_version_id is not null)
$$;

-- `seconds` scaled by companion.chat_pace.
create function companion_private.chat_seconds(p_seconds double precision)
returns interval language sql stable set search_path='' as $$
  select make_interval(secs => p_seconds * coalesce(nullif(current_setting('companion.chat_pace', true), '')::double precision, 1))
$$;

create function companion_private.chat_companion_json(p_companion uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('companionId', c.id, 'displayName', i.display_name)
  from public.companions c join public.companion_identities i on i.id = c.current_identity_version_id
  where c.id = p_companion
$$;

create function companion_private.chat_members_json(p_chat uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(companion_private.chat_companion_json(m.companion_id) order by m.position), '[]')
  from companion_private.chat_members m where m.chat_id = p_chat
$$;

create function companion_private.chat_message_json(m companion_private.chat_messages)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body, 'mentions', to_jsonb(m.mentions),
    'status', m.status, 'failure', m.failure, 'retryable', m.status = 'FAILED' and m.failure = 'ERROR', 'sentAt', m.shown_at)
$$;

-- typing: who shows "typing…" now. A message being typed out first; otherwise the turn next in line,
--   if it must answer and its reading delay passed. Optional turns show nothing while deciding,
--   and nobody behind them in line shows yet, so the dots never jump between Companions.
-- replying: more replies are on the way (keep refreshing), even when nobody shows as typing.
create function companion_private.chat_progress(c companion_private.chats)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'typing', case when exists(select 1 from companion_private.chat_messages x where x.chat_id = c.id and x.status = 'SENT' and x.shown_at > now())
      then coalesce((select jsonb_agg(distinct x.companion_id) from companion_private.chat_messages x
        where x.chat_id = c.id and x.status = 'SENT' and x.typing_at <= now() and x.shown_at > now()), '[]')
      else coalesce((select case when not x.optional and x.typing_at <= now() then jsonb_build_array(x.companion_id) end
        from companion_private.chat_messages x
        join companion_private.chat_members m on m.chat_id = x.chat_id and m.companion_id = x.companion_id
        where x.chat_id = c.id and x.status = 'PENDING' order by x.created_at, m.position, x.id limit 1), '[]') end,
    'replying', exists(select 1 from companion_private.chat_messages x where x.chat_id = c.id
      and (x.status = 'PENDING' or x.shown_at > now())))
$$;

create function companion_private.chat_json(c companion_private.chats)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', c.id, 'title', c.title, 'direct', c.direct_companion_id is not null,
    'members', companion_private.chat_members_json(c.id),
    'lastMessage', (select companion_private.chat_message_json(x) from companion_private.chat_messages x
      where x.chat_id = c.id and x.status in ('SENT', 'FAILED', 'BLOCKED') and x.shown_at <= now()
      order by x.shown_at desc, x.id desc limit 1),
    'activeAt', c.active_at) || companion_private.chat_progress(c)
$$;

create function companion_private.chat_settings_for(p_companion uuid)
returns companion_private.chat_settings language plpgsql security definer set search_path='' as $$
declare s companion_private.chat_settings%rowtype;
begin
  if not companion_private.chat_companion_ok(companion_private.chat_owner(), p_companion) then
    raise exception using errcode='P0001', message='companion not found';
  end if;
  insert into companion_private.chat_settings(companion_id) values (p_companion) on conflict do nothing;
  select * into s from companion_private.chat_settings where companion_id = p_companion;
  return s;
end $$;

create function companion_private.chat_settings_json(s companion_private.chat_settings)
returns jsonb language sql immutable as $$
  select jsonb_build_object('groupActivity', s.group_activity, 'companionInteraction', s.companion_interaction, 'revision', s.revision)
$$;

-- How many times a Companion may answer other Companions after one Owner message.
create function companion_private.chat_interaction_limit(p_level text)
returns integer language sql immutable as $$
  select case p_level when 'NONE' then 0 when 'RARE' then 1 when 'LIVELY' then 4 else 2 end
$$;

-- After a Companion's turn ends and nothing else is waiting: queue at most one other Companion to
-- answer, chosen among those with turns left and something new from someone else to answer,
-- the one that spoke least recently first. It may stay quiet (optional).
create function companion_private.chat_queue_followup(c companion_private.chats)
returns void language plpgsql security definer set search_path='' as $$
declare since timestamptz;
begin
  if c.direct_companion_id is not null then return; end if;
  select max(shown_at) into since from companion_private.chat_messages where chat_id = c.id and companion_id is null;
  if since is null
    or (select count(*) from companion_private.chat_messages where chat_id = c.id and companion_id is not null
        and status = 'SENT' and part = 1 and created_at >= since) >= 8
    or (select count(*) from companion_private.chat_messages where chat_id = c.id and companion_id is not null
        and part = 1 and created_at >= since) >= 16 then
    return;
  end if;
  insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
  select c.id, m.companion_id, 'PENDING', 'COMPANION', true
  from companion_private.chat_members m
  left join companion_private.chat_settings s on s.companion_id = m.companion_id
  cross join lateral (select max(x.shown_at) as last_at from companion_private.chat_messages x
    where x.chat_id = c.id and x.companion_id = m.companion_id and x.status in ('SENT', 'PASSED')) mine
  where m.chat_id = c.id and companion_private.chat_companion_ok(c.owner_id, m.companion_id)
    and companion_private.chat_interaction_limit(coalesce(s.companion_interaction, 'NORMAL'))
      > (select count(*) from companion_private.chat_messages x where x.chat_id = c.id and x.companion_id = m.companion_id
        and x.reply_to = 'COMPANION' and x.part = 1 and x.status in ('SENT', 'PASSED') and x.created_at >= since)
    and exists(select 1 from companion_private.chat_messages x where x.chat_id = c.id and x.status = 'SENT'
      and x.companion_id is not null and x.companion_id <> m.companion_id
      and x.shown_at > greatest(since, coalesce(mine.last_at, since)))
  order by mine.last_at asc nulls first, m.position
  limit 1;
end $$;

-- ---------- for the Owner (authenticated) ----------

-- One Companion: its one-to-one chat (created on first use, p_title must be null).
-- Two to eight: a new group; the same retry key returns the same group.
create function public.chat_open(p_companions uuid[], p_title text, p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); c companion_private.chats%rowtype;
  -- A plain list starting at 1, whatever bounds or dimensions a direct RPC caller sent.
  v_companions uuid[] := array(select unnest(p_companions));
  n integer := cardinality(v_companions); v_title text := nullif(btrim(p_title), '');
begin
  if n < 1 or n > 8 or (select count(distinct x) from unnest(v_companions) x where x is not null) <> n
    or (n = 1 and v_title is not null) or char_length(v_title) > 40 or p_key is null or p_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023', message='invalid chat';
  end if;
  if exists(select 1 from unnest(v_companions) x where not companion_private.chat_companion_ok(o, x)) then
    raise exception using errcode='P0001', message='companion not found';
  end if;
  if n = 1 then
    insert into companion_private.chats(owner_id, direct_companion_id) values (o, v_companions[1])
      on conflict (direct_companion_id) where direct_companion_id is not null do nothing returning * into c;
    if not found then
      select * into c from companion_private.chats where direct_companion_id = v_companions[1];
      return companion_private.chat_json(c);
    end if;
  else
    perform 1 from public.owners where id = o for no key update;
    select * into c from companion_private.chats where owner_id = o and key_hash = p_key;
    if found then
      if c.title is distinct from v_title or array(select companion_id from companion_private.chat_members
          where chat_id = c.id order by position) <> v_companions then
        raise exception using errcode='23505', message='idempotency conflict';
      end if;
      return companion_private.chat_json(c);
    end if;
    if (select count(*) from companion_private.chats where owner_id = o and direct_companion_id is null) >= 50 then
      raise exception using errcode='55000', message='group chat limit reached';
    end if;
    insert into companion_private.chats(owner_id, title, key_hash) values (o, v_title, p_key) returning * into c;
  end if;
  insert into companion_private.chat_members(chat_id, companion_id, position)
    select c.id, x, i from unnest(v_companions) with ordinality as t(x, i);
  insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
    values (o, 'OWNER', o, 'CHAT_CREATE', 'CHAT', c.id);
  return companion_private.chat_json(c);
end $$;

-- Every chat of the Owner, most recently active first (at most 50 groups plus one per Companion).
create function public.chat_list()
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(companion_private.chat_json(c) order by c.active_at desc, c.id desc), '[]'))
  from companion_private.chats c where c.owner_id = companion_private.chat_owner()
$$;

-- One chat and a page of its shown messages, newest first, 30 per page with a cursor "sentAt|id".
create function public.chat_read(p_chat uuid, p_before_at timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; items jsonb; n integer; last_item jsonb;
begin
  if (p_before_at is null) <> (p_before_id is null) then raise exception using errcode='22023', message='invalid cursor'; end if;
  select * into c from companion_private.chats where id = p_chat and owner_id = companion_private.chat_owner();
  if not found then raise exception using errcode='P0001', message='chat not found'; end if;
  select coalesce(jsonb_agg(companion_private.chat_message_json(q.x) order by (q.x).shown_at desc, (q.x).id desc), '[]') into items
  from (select x from companion_private.chat_messages x
    where x.chat_id = c.id and x.status in ('SENT', 'FAILED', 'BLOCKED') and x.shown_at <= now()
      and (p_before_at is null or (x.shown_at, x.id) < (p_before_at, p_before_id))
    order by x.shown_at desc, x.id desc limit 31) q;
  n := jsonb_array_length(items);
  if n > 30 then items := items - 30; end if;
  last_item := items->(jsonb_array_length(items) - 1);
  return jsonb_build_object('chat', companion_private.chat_json(c), 'items', items,
    'nextCursor', case when n > 30 then to_char((last_item->>'sentAt')::timestamptz at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || (last_item->>'id') end);
end $$;

-- The Owner sends a message; returns it with typing and replying. A retry with the same key
-- returns the first message (and queues nothing); the same key with other text is a conflict.
create function public.chat_send(p_chat uuid, p_body text, p_mentions uuid[], p_key text)
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

-- Try a failed reply again (only failure ERROR; a reply blocked by the safety scan is final).
create function public.chat_retry(p_chat uuid, p_message uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype;
begin
  c := companion_private.chat_for(p_chat);
  select * into m from companion_private.chat_messages where id = p_message and chat_id = c.id and companion_id is not null;
  if not found then raise exception using errcode='P0001', message='message not found'; end if;
  if m.status <> 'FAILED' or m.failure <> 'ERROR' then raise exception using errcode='55000', message='message cannot be retried'; end if;
  -- Asked again by the Owner, so it must answer now.
  update companion_private.chat_messages set status = 'PENDING', failure = null, shown_at = null, optional = false,
    typing_at = now() + companion_private.chat_seconds(1), claim_id = null, claimed_at = null, attempts = 0 where id = m.id;
  return companion_private.chat_progress(c);
end $$;

-- Deletes the chat and every message in it.
create function public.chat_delete(p_chat uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype;
begin
  c := companion_private.chat_for(p_chat);
  delete from companion_private.chats where id = c.id;
  insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
    values (c.owner_id, 'OWNER', c.owner_id, 'CHAT_DELETE', 'CHAT', c.id);
  return jsonb_build_object('deleted', true);
end $$;

create function public.chat_get_settings(p_companion uuid)
returns jsonb language sql security definer set search_path='' as $$
  select companion_private.chat_settings_json(companion_private.chat_settings_for(p_companion))
$$;

-- Replaces both settings. A stale revision (another device saved first) is a conflict.
create function public.chat_update_settings(p_companion uuid, p_group_activity text, p_companion_interaction text, p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.chat_settings%rowtype; o uuid := companion_private.chat_owner();
begin
  s := companion_private.chat_settings_for(p_companion);
  update companion_private.chat_settings set group_activity = p_group_activity,
    companion_interaction = p_companion_interaction, revision = revision + 1
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='chat settings revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'CHAT_UPDATE_SETTINGS', 'COMPANION', s.companion_id);
  return companion_private.chat_settings_json(s);
end $$;

-- ---------- for the API server only (companion_api) ----------

-- Takes the next turn to write in this chat, or returns null when there is none or another one
-- is being written (a claim older than 2 minutes counts as abandoned; after 3 tries it fails).
-- Returns what the writer needs: whether it may stay quiet, the Companion's approved identity
-- and chat settings, the members, and the last 30 Companion-visible messages, oldest first.
create function public.chat_claim(p_chat uuid)
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
    exit when m.attempts < 3 and companion_private.chat_companion_ok(c.owner_id, m.companion_id);
    if m.optional then
      update companion_private.chat_messages set status = 'PASSED', shown_at = now(), typing_at = null, claim_id = null where id = m.id;
    else
      update companion_private.chat_messages set status = 'FAILED', shown_at = now(), typing_at = null, claim_id = null,
        failure = case when m.attempts >= 3 then 'ERROR' else 'UNAVAILABLE' end where id = m.id;
    end if;
    skipped := true;
  end loop;
  update companion_private.chat_messages set claim_id = claim, claimed_at = now(), attempts = attempts + 1 where id = m.id;
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

-- Ends a claimed turn: SENT with 1 to 3 messages in p_bodies, PASSED (optional turns only),
-- BLOCKED, or failed with ERROR / UNAVAILABLE. A stale claim (the reply was retried, dropped or
-- the chat deleted) is ignored: {"accepted": false}. Sets when each message is typed and shown.
create function public.chat_finish(p_reply uuid, p_claim uuid, p_outcome text, p_bodies text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid;
  v_bodies text[] := array(select btrim(b) from unnest(p_bodies) b); n integer := coalesce(cardinality(p_bodies), 0);
  pause interval := companion_private.chat_seconds(0.6); start_at timestamptz; done_at timestamptz; i integer;
begin
  if p_outcome is null or p_outcome not in ('SENT', 'PASSED', 'BLOCKED', 'ERROR', 'UNAVAILABLE')
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
          shown_at = done_at, claim_id = null where id = m.id;
      else
        insert into companion_private.chat_messages(chat_id, companion_id, body, status, reply_to, optional, part,
            created_at, typing_at, shown_at)
          values (c.id, m.companion_id, v_bodies[i], 'SENT', m.reply_to, m.optional, i, m.created_at, start_at, done_at);
      end if;
      start_at := done_at + pause;
    end loop;
  else
    update companion_private.chat_messages set
      status = case when p_outcome in ('ERROR', 'UNAVAILABLE') then 'FAILED' else p_outcome end,
      failure = case when p_outcome in ('ERROR', 'UNAVAILABLE') then p_outcome end,
      typing_at = null, shown_at = greatest(now(), coalesce(done_at, now())), claim_id = null
    where id = m.id;
  end if;
  if p_outcome <> 'PASSED' then update companion_private.chats set active_at = now() where id = c.id returning * into c; end if;
  if not exists(select 1 from companion_private.chat_messages where chat_id = c.id and status = 'PENDING') then
    perform companion_private.chat_queue_followup(c);
  end if;
  return jsonb_build_object('accepted', true);
end $$;

revoke all on function companion_private.chat_owner(), companion_private.chat_for(uuid),
  companion_private.chat_companion_ok(uuid, uuid), companion_private.chat_seconds(double precision),
  companion_private.chat_companion_json(uuid), companion_private.chat_members_json(uuid),
  companion_private.chat_message_json(companion_private.chat_messages),
  companion_private.chat_progress(companion_private.chats), companion_private.chat_json(companion_private.chats),
  companion_private.chat_settings_for(uuid), companion_private.chat_settings_json(companion_private.chat_settings),
  companion_private.chat_interaction_limit(text), companion_private.chat_queue_followup(companion_private.chats)
  from public, anon, authenticated;
revoke all on function public.chat_open(uuid[], text, text), public.chat_list(), public.chat_read(uuid, timestamptz, uuid),
  public.chat_send(uuid, text, uuid[], text), public.chat_retry(uuid, uuid), public.chat_delete(uuid),
  public.chat_get_settings(uuid), public.chat_update_settings(uuid, text, text, integer),
  public.chat_claim(uuid), public.chat_finish(uuid, uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.chat_open(uuid[], text, text), public.chat_list(), public.chat_read(uuid, timestamptz, uuid),
  public.chat_send(uuid, text, uuid[], text), public.chat_retry(uuid, uuid), public.chat_delete(uuid),
  public.chat_get_settings(uuid), public.chat_update_settings(uuid, text, text, integer) to authenticated;
-- Writing a Companion's words is the server's job: not reachable through Supabase's own REST API.
grant execute on function public.chat_claim(uuid), public.chat_finish(uuid, uuid, text, text[]) to companion_api;

commit;
