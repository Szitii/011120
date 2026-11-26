begin;

-- 意见反馈: an Owner tells the team what to improve, and the team answers.
--
--  * One feedback is a short thread: the Owner's first message, then any answers from the team and
--    follow-ups from the Owner, oldest first. Only the Owner and the operators can read it.
--  * The Owner sees "unread" when the team has written since the Owner last opened the thread; the
--    home badges count such threads.
--  * The team can close a thread (handled). A follow-up from the Owner opens it again.
--  * Operators answer and close from the console; each answer and each close is in the admin log,
--    with the text that was sent.
--  * At most 20 messages from one Owner a day, over all their threads.

create table companion_private.feedback (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  -- What the App says it is, to tell which build a problem is in. Both optional.
  app_version text check (char_length(app_version) between 1 and 40),
  platform text check (platform in ('IOS', 'ANDROID', 'WEB')),
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  -- The Owner's retry key for the first message, so a retried request does not open two threads.
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  -- When the last message was written.
  updated_at timestamptz not null default now(),
  -- When the Owner last opened the thread: team messages after this are unread.
  owner_read_at timestamptz not null default now(),
  unique (owner_id, key_hash)
);
create index feedback_owner on companion_private.feedback(owner_id, updated_at desc, id desc);
create index feedback_queue on companion_private.feedback(status, updated_at desc, id desc);

create table companion_private.feedback_messages (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references companion_private.feedback(id) on delete cascade,
  author text not null check (author in ('OWNER', 'TEAM')),
  -- The operator's database login for a team answer (never shown to the Owner).
  operator text,
  body text not null check (char_length(body) between 1 and 2000 and body ~ '\S'),
  -- The Owner's retry key for a follow-up.
  key_hash text check (key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  check ((author = 'TEAM') = (operator is not null)),
  check (author = 'OWNER' or key_hash is null),
  unique (feedback_id, key_hash)
);
create index feedback_messages_thread on companion_private.feedback_messages(feedback_id, created_at, id);

alter table companion_private.feedback enable row level security;
alter table companion_private.feedback force row level security;
alter table companion_private.feedback_messages enable row level security;
alter table companion_private.feedback_messages force row level security;
revoke all on companion_private.feedback, companion_private.feedback_messages from public, anon, authenticated;

-- A thread as the Owner sees it: no operator names.
create function companion_private.feedback_json(p_feedback uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', f.id, 'status', f.status, 'createdAt', f.created_at, 'updatedAt', f.updated_at,
    'unread', exists(select 1 from companion_private.feedback_messages m
      where m.feedback_id = f.id and m.author = 'TEAM' and m.created_at > f.owner_read_at),
    'messages', (select jsonb_agg(jsonb_build_object('id', m.id, 'author', m.author, 'body', m.body, 'createdAt', m.created_at)
      order by m.created_at, m.id) from companion_private.feedback_messages m where m.feedback_id = f.id))
  from companion_private.feedback f where f.id = p_feedback
$$;

-- The body trimmed; refused when empty or longer than 2000 characters.
create function companion_private.feedback_body(p_body text)
returns text language plpgsql immutable set search_path='' as $$
begin
  if p_body is null or btrim(p_body) !~ '\S' or char_length(btrim(p_body)) > 2000 then
    raise exception using errcode='22023', message='invalid feedback';
  end if;
  return btrim(p_body);
end $$;

-- Refuses the Owner's 21st message of the last 24 hours.
create function companion_private.feedback_room(p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if (select count(*) from companion_private.feedback_messages m join companion_private.feedback f on f.id = m.feedback_id
      where f.owner_id = p_owner and m.author = 'OWNER' and m.created_at > now() - interval '1 day') >= 20 then
    raise exception using errcode='55000', message='too much feedback today';
  end if;
end $$;

-- ---------- the Owner ----------

-- The Owner's threads, most recently active first (at most 50).
create function public.feedback_list()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  return jsonb_build_object('items', coalesce((select jsonb_agg(companion_private.feedback_json(q.id) order by q.updated_at desc, q.id desc)
    from (select id, updated_at from companion_private.feedback where owner_id = o order by updated_at desc, id desc limit 50) q), '[]'));
end $$;

-- A new thread. The same key returns the first one; with other text it is a conflict.
create function public.feedback_send(p_body text, p_app_version text, p_platform text, p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); v_body text := companion_private.feedback_body(p_body); f uuid; first text;
begin
  if p_key is null or p_key !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023', message='invalid feedback'; end if;
  perform 1 from public.owners where id = o for no key update;
  select id into f from companion_private.feedback where owner_id = o and key_hash = p_key;
  if found then
    select body into first from companion_private.feedback_messages where feedback_id = f order by created_at, id limit 1;
    if first <> v_body then raise exception using errcode='23505', message='idempotency conflict'; end if;
    return companion_private.feedback_json(f);
  end if;
  perform companion_private.feedback_room(o);
  insert into companion_private.feedback(owner_id, app_version, platform, key_hash)
    values (o, nullif(btrim(p_app_version), ''), p_platform, p_key) returning id into f;
  insert into companion_private.feedback_messages(feedback_id, author, body) values (f, 'OWNER', v_body);
  return companion_private.feedback_json(f);
end $$;

-- A follow-up in one of the Owner's threads. It opens a closed thread again.
create function public.feedback_add(p_feedback uuid, p_body text, p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); v_body text := companion_private.feedback_body(p_body); m companion_private.feedback_messages%rowtype;
begin
  if p_key is null or p_key !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023', message='invalid feedback'; end if;
  perform 1 from companion_private.feedback where id = p_feedback and owner_id = o for update;
  if not found then raise exception using errcode='P0001', message='feedback not found'; end if;
  select * into m from companion_private.feedback_messages where feedback_id = p_feedback and key_hash = p_key;
  if found then
    if m.body <> v_body then raise exception using errcode='23505', message='idempotency conflict'; end if;
    return companion_private.feedback_json(p_feedback);
  end if;
  perform companion_private.feedback_room(o);
  insert into companion_private.feedback_messages(feedback_id, author, body, key_hash) values (p_feedback, 'OWNER', v_body, p_key);
  -- Writing in the thread means the Owner has read it.
  update companion_private.feedback set status = 'OPEN', updated_at = now(), owner_read_at = now() where id = p_feedback;
  return companion_private.feedback_json(p_feedback);
end $$;

-- The Owner opened the thread: the team's answers so far are read.
create function public.feedback_read(p_feedback uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  update companion_private.feedback set owner_read_at = now() where id = p_feedback and owner_id = o;
  if not found then raise exception using errcode='P0001', message='feedback not found'; end if;
  return companion_private.feedback_json(p_feedback);
end $$;

-- The home badges (0046) and how many threads have an unread answer.
create or replace function public.home_badges()
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
      where a.owner_id = o and (a.kind = 'HUMAN' or (t.status <> 'SUSPENDED' and co.status not in ('DELETED', 'QUARANTINED')))), '[]'),
    'feedback', (select count(*) from companion_private.feedback f where f.owner_id = o
      and exists(select 1 from companion_private.feedback_messages m
        where m.feedback_id = f.id and m.author = 'TEAM' and m.created_at > f.owner_read_at)));
end $$;

-- ---------- the operators ----------

-- Threads with the given status, 100 at most: those waiting for an answer (the Owner wrote last)
-- first, oldest wait first; then the rest, most recently active first. `waiting` counts every
-- open thread waiting for an answer (the sidebar badge).
create function companion_admin.feedback(p_status text default 'OPEN')
returns jsonb language sql stable security definer set search_path='' as $$
  with t as (
    select f.*, (select m.author from companion_private.feedback_messages m where m.feedback_id = f.id
      order by m.created_at desc, m.id desc limit 1) = 'OWNER' as waiting
    from companion_private.feedback f)
  select jsonb_build_object(
    'waiting', (select count(*) from t where t.status = 'OPEN' and t.waiting),
    'items', coalesce((select jsonb_agg(q.item order by q.n) from (
      select row_number() over (order by t.waiting desc, case when t.waiting then t.updated_at end, t.updated_at desc, t.id) as n,
        jsonb_build_object('id', t.id, 'status', t.status, 'waiting', t.waiting, 'appVersion', t.app_version, 'platform', t.platform,
          'createdAt', t.created_at, 'updatedAt', t.updated_at,
          'owner', (select jsonb_build_object('id', o.id, 'email', u.email, 'displayName', o.display_name, 'status', o.status)
            from public.owners o join auth.users u on u.id = o.auth_user_id where o.id = t.owner_id),
          'messages', (select jsonb_agg(jsonb_build_object('id', m.id, 'author', m.author, 'operator', m.operator, 'body', m.body,
              'createdAt', m.created_at) order by m.created_at, m.id)
            from companion_private.feedback_messages m where m.feedback_id = t.id)) as item
      from t where t.status = p_status order by 1 limit 100) q), '[]'))
$$;

-- An answer to the Owner, optionally closing the thread. Logged with the text.
create function companion_admin.feedback_reply(p_feedback uuid, p_body text, p_close boolean, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_body text := companion_private.feedback_body(p_body); f companion_private.feedback%rowtype;
begin
  select * into f from companion_private.feedback where id = p_feedback for update;
  if not found then raise exception using errcode='P0001', message='feedback not found'; end if;
  insert into companion_private.feedback_messages(feedback_id, author, operator, body) values (f.id, 'TEAM', session_user, v_body);
  update companion_private.feedback set updated_at = now(), status = case when p_close then 'CLOSED' else 'OPEN' end where id = f.id;
  perform companion_private.admin_note('FEEDBACK_REPLY', 'FEEDBACK', f.id::text, f.owner_id, p_reason,
    jsonb_build_object('body', v_body, 'closed', coalesce(p_close, false)));
end $$;

-- Close a thread without answering, or open it again. Logged.
create function companion_admin.feedback_close(p_feedback uuid, p_close boolean, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare f companion_private.feedback%rowtype;
begin
  select * into f from companion_private.feedback where id = p_feedback for update;
  if not found then raise exception using errcode='P0001', message='feedback not found'; end if;
  if (f.status = 'CLOSED') = p_close then raise exception using errcode='55000', message='feedback already in that state'; end if;
  update companion_private.feedback set status = case when p_close then 'CLOSED' else 'OPEN' end where id = f.id;
  perform companion_private.admin_note(case when p_close then 'FEEDBACK_CLOSE' else 'FEEDBACK_REOPEN' end, 'FEEDBACK', f.id::text,
    f.owner_id, p_reason);
end $$;

revoke all on function companion_private.feedback_json(uuid), companion_private.feedback_body(text), companion_private.feedback_room(uuid),
  public.feedback_list(), public.feedback_send(text, text, text, text), public.feedback_add(uuid, text, text), public.feedback_read(uuid),
  companion_admin.feedback(text), companion_admin.feedback_reply(uuid, text, boolean, text), companion_admin.feedback_close(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.feedback_list(), public.feedback_send(text, text, text, text), public.feedback_add(uuid, text, text),
  public.feedback_read(uuid) to authenticated;
grant execute on function companion_admin.feedback(text), companion_admin.feedback_reply(uuid, text, boolean, text),
  companion_admin.feedback_close(uuid, boolean, text) to companion_admin;

commit;
