begin;

-- Pictures in chat (聊天里发图片): the Owner sends 1 to 4 pictures with a message, and the
-- Companion understands them.
--
-- The files go where post images and avatars go: the private bucket `media`, uploaded by the app
-- with the Owner's own sign-in, as "chat/<uuid>.jpg|png|webp". The folder is flat, so a name says
-- nothing about whose it is; Storage records who uploaded it (storage.objects.owner_id). Then
--   POST /v0/chats/{id}/messages  { "body"?: "…", "images": [{ "path": "chat/<uuid>.jpg", "width"?, "height"? }] }
-- names them. The database checks that each file is there, that this Owner uploaded it and that
-- it is on no message yet. A message with pictures and no words has the body "[图片]".
--
-- The three Storage rules of 0061 and 0082 learn the new folder:
--   upload  an Owner in good standing, under a name that is on no message; at most 60 in an hour
--           and 40 not yet on a message
--   read    one's own files only: nobody else ever reads a chat picture
--   delete  one's own files that are on no message (a picture not sent after all; or one whose
--           message, chat or Companion was deleted: the rows here go with the message, the file
--           stays until the app deletes it)
-- The bucket's limits stay: 1 MB, jpeg/png/webp.
--
-- Understanding: when a Companion's turn comes, the API server fetches the pictures it has not
-- looked at yet (with the Owner's sign-in of the request that started the turn), has the
-- platform's picture-reading model describe each one, and keeps the description here
-- (chat_image_seen). From then on the description stands for the picture wherever the
-- conversation is read: in later replies, for a model that cannot take pictures, for a Companion
-- on the Owner's own key or agent. A model that can take pictures is given the recent ones
-- themselves as well. A picture that could not be read after two tries is told as one the
-- Companion cannot see, and the app says so.
--
-- chat_quota.daily_images caps how many pictures one Owner sends per UTC day (default 30).

-- As in 0061: the functions below read storage.objects as their owner, whoever runs this migration.
do $$ begin
  if not has_table_privilege(current_user, 'storage.objects', 'SELECT')
    or not (select rolsuper or rolbypassrls from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'this migration must be run by a role that can read every row of storage.objects';
  end if;
end $$;

alter table companion_private.chat_quota
  add column daily_images integer not null default 30 check (daily_images between 0 and 100000);

-- "chat/<uuid>.<jpg|png|webp>"
create function public.media_is_chat(p_name text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_name ~ '^chat/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|webp)$', false)
$$;

-- attempts: how often the API server tried to have it described. description null with two
-- tries: the Companion cannot see this one.
create table companion_private.chat_images (
  object_name text primary key check (public.media_is_chat(object_name)),
  message_id uuid not null references companion_private.chat_messages(id) on delete cascade,
  position smallint not null check (position between 1 and 4),
  width integer check (width between 1 and 99999),
  height integer check (height between 1 and 99999),
  description text check (char_length(description) between 1 and 1000),
  attempts smallint not null default 0,
  looked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (message_id, position)
);
create index chat_images_created on companion_private.chat_images(created_at);
alter table companion_private.chat_images enable row level security;
alter table companion_private.chat_images force row level security;
revoke all on companion_private.chat_images from public, anon, authenticated;

-- ---------- what a signed-in user may do with a chat picture file (used by the Storage policies) ----------

-- A chat picture name that is on no message.
create function public.media_chat_unused(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.media_is_chat(p_name) and not exists(select 1 from companion_private.chat_images i where i.object_name = p_name)
$$;

-- As in 0082, or: a chat picture, from an Owner in good standing who uploaded fewer than 60 in the
-- last hour and keeps fewer than 40 that are on no message. (As there, the counts are not a hard quota.)
create or replace function public.media_can_upload(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select (public.media_own(p_name)
    and split_part(p_name, '/', 1) in (select v.id::text from companion_private.media_actors() v(id))
    and not exists(select 1 from companion_private.post_media m where m.object_name = p_name)
    and (select count(*) from companion_private.media_actors() v(id) join storage.objects f
      on f.bucket_id = 'media' and f.name like v.id::text || '/%' where f.created_at > now() - interval '1 hour') < 60
    and (select count(*) from companion_private.media_actors() v(id) join storage.objects f
      on f.bucket_id = 'media' and f.name like v.id::text || '/%'
      where not exists(select 1 from companion_private.post_media m where m.object_name = f.name)) < 40)
  or (public.media_avatar_unused(p_name)
    and exists(select 1 from public.owners o where o.auth_user_id = (select auth.uid()) and o.status = 'ACTIVE')
    and (select count(*) < 30 and count(*) filter (where f.created_at > now() - interval '1 hour') < 20
      from storage.objects f where f.bucket_id = 'media' and f.name like 'avatar/%'
        and f.owner_id::text = (select auth.uid())::text))
  or (public.media_chat_unused(p_name)
    and exists(select 1 from public.owners o where o.auth_user_id = (select auth.uid()) and o.status = 'ACTIVE')
    and (select count(*) filter (where f.created_at > now() - interval '1 hour') < 60
        and count(*) filter (where not exists(select 1 from companion_private.chat_images i where i.object_name = f.name)) < 40
      from storage.objects f where f.bucket_id = 'media' and f.name like 'chat/%'
        and f.owner_id::text = (select auth.uid())::text))
$$;

-- As in 0082, plus: one's own chat pictures are read, and deleted while on no message. Read from
-- the row (owner_id), as there.
alter policy media_read on storage.objects
  using (bucket_id = 'media' and (public.media_can_read(name)
    or (owner_id::text = (select auth.uid())::text and (public.media_is_avatar(name) or public.media_is_chat(name)))));
alter policy media_delete on storage.objects
  using (bucket_id = 'media' and (public.media_can_delete(name)
    or (owner_id::text = (select auth.uid())::text and (public.media_avatar_unused(name) or public.media_chat_unused(name)))));

-- ---------- messages carry their pictures ----------

-- As in 0085, plus images: [{path, width, height, seen}] in the order they were sent. seen: true
-- once the Companion has a description of it, false when it cannot see it, null while nobody has
-- looked yet.
create or replace function companion_private.chat_message_json(m companion_private.chat_messages)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body, 'action', m.action,
    'mentions', to_jsonb(m.mentions), 'status', m.status, 'failure', m.failure,
    'connectionFailure', case when m.status = 'FAILED' and m.failure = 'ERROR' then m.failure_detail end,
    'retryable', m.status = 'FAILED' and m.failure = 'ERROR', 'sentAt', m.shown_at,
    'audio', (select jsonb_build_object('durationMs', a.duration_ms) from companion_private.chat_audio a where a.message_id = m.id),
    'images', coalesce((select jsonb_agg(jsonb_build_object('path', i.object_name, 'width', i.width, 'height', i.height,
        'seen', case when i.description is not null then true when i.attempts >= 2 then false end) order by i.position)
      from companion_private.chat_images i where i.message_id = m.id), '[]'),
    'reminder', (select companion_private.chat_reminder_json(r) from companion_private.chat_reminders r
      where r.message_id = m.id order by r.created_at, r.id limit 1),
    'reach', case m.reply_to when 'SELF' then 'GREETING' when 'REMINDER' then 'REMINDER' end)
$$;

-- Pictures the signed-in Owner sent today (UTC).
create function companion_private.chat_images_used()
returns bigint language sql stable security definer set search_path='' as $$
  select count(*) from companion_private.chat_images i
    join companion_private.chat_messages m on m.id = i.message_id
    join companion_private.chats c on c.id = m.chat_id
  where c.owner_id = companion_private.chat_owner()
    and i.created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
$$;

drop function public.chat_send(uuid, text, uuid[], text);
-- As in 0041, plus p_images: null or [{"path", "width"?, "height"?}], 1 to 4 pictures the Owner
-- uploaded to the chat folder, each on no message yet; otherwise nothing is sent. With pictures
-- the words may be left out (the body is then "[图片]"). A retry with the same key and other
-- pictures is a conflict. Past the day's pictures: 'image limit reached'. (p_images comes last
-- with a default, so the API server deployed before this migration keeps working.)
create function public.chat_send(p_chat uuid, p_body text, p_mentions uuid[], p_key text, p_images jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype;
  v_mentions uuid[] := array(select unnest(p_mentions)); -- a plain list, like chat_open
  v_images jsonb := case when p_images is null or jsonb_typeof(p_images) = 'null' then '[]'::jsonb else p_images end;
  v_paths text[]; v_body text := btrim(p_body);
begin
  c := companion_private.chat_for(p_chat);
  if jsonb_typeof(v_images) <> 'array' or jsonb_array_length(v_images) > 4
    or exists(select 1 from jsonb_array_elements(v_images) e where jsonb_typeof(e) <> 'object'
      or jsonb_typeof(e->'path') is distinct from 'string' or not public.media_is_chat(e->>'path')
      or coalesce(e->>'width', '1') !~ '^[1-9][0-9]{0,4}$' or coalesce(e->>'height', '1') !~ '^[1-9][0-9]{0,4}$') then
    raise exception using errcode='22023', message='invalid message';
  end if;
  v_paths := array(select e->>'path' from jsonb_array_elements(v_images) with ordinality t(e, n) order by n);
  -- Pictures can go without words.
  if cardinality(v_paths) > 0 and (v_body is null or v_body !~ '\S') then v_body := '[图片]'; end if;
  if v_body is null or v_body !~ '\S' or char_length(v_body) > 2000 or p_key is null or p_key !~ '^[a-f0-9]{64}$'
    or cardinality(v_mentions) > 8 or (select count(distinct x) from unnest(v_mentions) x where x is not null) <> cardinality(v_mentions)
    or exists(select 1 from unnest(v_mentions) x where not exists(
      select 1 from companion_private.chat_members where chat_id = c.id and companion_id = x))
    or (select count(distinct x) from unnest(v_paths) x) <> cardinality(v_paths) then
    raise exception using errcode='22023', message='invalid message';
  end if;
  select * into m from companion_private.chat_messages where chat_id = c.id and key_hash = p_key;
  if found then
    if m.body is distinct from v_body or m.mentions <> v_mentions
      or v_paths <> array(select i.object_name from companion_private.chat_images i where i.message_id = m.id order by i.position) then
      raise exception using errcode='23505', message='idempotency conflict';
    end if;
    return jsonb_build_object('message', companion_private.chat_message_json(m)) || companion_private.chat_progress(c);
  end if;
  if (select count(*) from companion_private.chat_messages x join companion_private.chats y on y.id = x.chat_id
      where y.owner_id = c.owner_id and x.companion_id is null and x.created_at > now() - interval '1 hour') >= 300 then
    raise exception using errcode='55000', message='chat message limit reached';
  end if;
  if cardinality(v_paths) > 0 then
    -- Files this Owner uploaded, each on no message yet.
    if exists(select 1 from unnest(v_paths) x where exists(select 1 from companion_private.chat_images i where i.object_name = x)
        or not exists(select 1 from storage.objects f where f.bucket_id = 'media' and f.name = x
          and f.owner_id::text = (select auth.uid())::text)) then
      raise exception using errcode='22023', message='invalid message';
    end if;
    if companion_private.chat_images_used() + cardinality(v_paths) > (select q.daily_images from companion_private.chat_quota q) then
      raise exception using errcode='55000', message='image limit reached';
    end if;
  end if;
  insert into companion_private.chat_messages(chat_id, body, mentions, status, key_hash, shown_at)
    values (c.id, v_body, v_mentions, 'SENT', p_key, now()) returning * into m;
  insert into companion_private.chat_images(object_name, message_id, position, width, height)
    select e->>'path', m.id, n, (e->>'width')::integer, (e->>'height')::integer
    from jsonb_array_elements(v_images) with ordinality t(e, n);
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

-- Server only: what the picture-reading model made of one of the signed-in Owner's chat pictures
-- (p_description), or that it could not be read this time (null). A picture that already has a
-- description keeps it. {"noted": false} when there is no such picture to note it on.
create function public.chat_image_seen(p_path text, p_description text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); v_description text := btrim(p_description, E' \t\r\n');
begin
  if p_description is not null and (v_description !~ '\S' or char_length(v_description) > 1000) then
    raise exception using errcode='22023', message='invalid description';
  end if;
  update companion_private.chat_images i set description = v_description, attempts = i.attempts + 1, looked_at = now()
    from companion_private.chat_messages m join companion_private.chats c on c.id = m.chat_id
    where i.object_name = p_path and m.id = i.message_id and c.owner_id = o and i.description is null;
  return jsonb_build_object('noted', found);
end $$;

drop function public.chat_reserve(uuid, uuid, text, text, text, text, bigint, bigint, bigint, text);
-- As in 0070, plus p_step. Until now a turn made one model call of each purpose, and the ledger
-- told the calls of a turn apart by purpose alone: a second REPLY call of the same turn with other
-- numbers was refused as a reused key. A turn with pictures makes more: one to describe each new
-- picture, then the reply. Each is an entry of its own, named by its step ('' for the reply itself,
-- so a turn with one call books exactly as before; "see:<file uuid>" for a description). (p_step
-- comes last with a default, so the API server deployed before this migration keeps working.)
create function public.chat_reserve(p_reply uuid, p_claim uuid, p_purpose text, p_provider text, p_model text,
  p_pricing_version text, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_trace text, p_step text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid; result jsonb;
begin
  if p_purpose is null or p_purpose not in ('REPLY', 'DECIDE') or p_step is null or p_step !~ '^[a-z0-9:-]{0,60}$' then
    raise exception using errcode='22023', message='invalid purpose';
  end if;
  select chat_id into v_chat from companion_private.chat_messages where id = p_reply;
  select * into c from companion_private.chats where id = v_chat and owner_id = companion_private.chat_owner() for update;
  if not found then return jsonb_build_object('decision', 'STALE'); end if;
  select * into m from companion_private.chat_messages where id = p_reply;
  if m.status <> 'PENDING' or m.claim_id is distinct from p_claim then return jsonb_build_object('decision', 'STALE'); end if;
  result := companion_private.compute_book(c.owner_id, m.companion_id,
    case p_purpose when 'REPLY' then 'OWNER_DIRECT_RESPONSE' else 'CHAT_TURN_DECISION' end, 'CHAT_MESSAGE', m.id, 'CHAT',
    m.reply_to in ('SELF', 'REMINDER'),
    p_provider, p_model, p_pricing_version, p_input_tokens, p_output_tokens, p_cost_minor, 'chat/1', 'chat-history/1', 'chat-router/1',
    p_trace, m.attempts, encode(sha256(convert_to(m.claim_id::text || ':' || p_purpose || case when p_step = '' then '' else ':' || p_step end,'UTF8')), 'hex'));
  if result->>'decision' = 'RESERVED' then
    update companion_private.chat_messages set compute_tx = (result->>'transactionId')::uuid where id = m.id;
  end if;
  return result;
end $$;

-- As in 0071, plus images on each message of the history: [{path, description, tries}] (null for
-- a message without pictures).
create or replace function public.chat_claim(p_chat uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; claim uuid := gen_random_uuid();
  skipped boolean := false; r companion_private.chat_reminders%rowtype; reach boolean;
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
    r := null;
    if m.reply_to = 'REMINDER' then
      select * into r from companion_private.chat_reminders where turn_id = m.id and status = 'WAITING';
    end if;
    exit when m.attempts < 3 and companion_private.chat_companion_ok(c.owner_id, m.companion_id)
      and not (m.reply_to = 'SELF' and (m.created_at < now() - interval '10 minutes'
        or exists(select 1 from companion_private.chat_messages h
          where h.chat_id = c.id and h.companion_id is null and h.status = 'SENT' and h.created_at > m.created_at)))
      and not (m.reply_to = 'REMINDER' and r.id is null);
    if m.optional then
      update companion_private.chat_messages set status = 'PASSED', shown_at = now(), typing_at = null, claim_id = null,
        compute_tx = null where id = m.id;
      update companion_private.chat_reminders set turn_id = null where turn_id = m.id and status = 'WAITING';
    else
      update companion_private.chat_messages set status = 'FAILED', shown_at = now(), typing_at = null, claim_id = null,
        compute_tx = null, failure = case when m.attempts >= 3 then 'ERROR' else 'UNAVAILABLE' end where id = m.id;
    end if;
    skipped := true;
  end loop;
  update companion_private.chat_messages set claim_id = claim, claimed_at = now(), attempts = attempts + 1, compute_tx = null
    where id = m.id;
  reach := m.reply_to = 'OWNER' and c.direct_companion_id is not null and companion_private.feature_on('COMPANION_REACH');
  return jsonb_build_object('chatId', c.id, 'replyId', m.id, 'claimId', claim, 'replyTo', m.reply_to,
    'optional', m.optional, 'direct', c.direct_companion_id is not null,
    'companion', companion_private.chat_companion_json(m.companion_id)
      || jsonb_build_object('identity', (select i.identity_document from public.companions x
        join public.companion_identities i on i.id = x.current_identity_version_id where x.id = m.companion_id))
      || jsonb_build_object('settings', companion_private.chat_settings_json(companion_private.chat_settings_for(m.companion_id))),
    'members', companion_private.chat_members_json(c.id),
    'history', coalesce((select jsonb_agg(jsonb_build_object('companionId', q.companion_id, 'body', q.body, 'action', q.action,
        'mentions', to_jsonb(q.mentions), 'sentAt', q.shown_at,
        'voice', exists(select 1 from companion_private.chat_audio a where a.message_id = q.id),
        'images', (select jsonb_agg(jsonb_build_object('path', i.object_name, 'description', i.description, 'tries', i.attempts) order by i.position)
          from companion_private.chat_images i where i.message_id = q.id)) order by q.shown_at, q.id)
      from (select * from companion_private.chat_messages h where h.chat_id = c.id and h.status = 'SENT'
        -- The Owner's actions in a row read as the last of them, so taps cannot push the conversation out of the 30.
        and (h.action is null or h.companion_id is not null or coalesce((select n.action is null or n.companion_id is not null
          from companion_private.chat_messages n
          where n.chat_id = h.chat_id and n.status = 'SENT' and (n.shown_at, n.id) > (h.shown_at, h.id)
          order by n.shown_at, n.id limit 1), true))
        order by h.shown_at desc, h.id desc limit 30) q), '[]'),
    'canAct', c.direct_companion_id is not null and companion_private.feature_on('COMPANION_ACTIONS'),
    'reach', case m.reply_to when 'SELF' then jsonb_build_object('kind', 'GREETING')
      when 'REMINDER' then jsonb_build_object('kind', 'REMINDER', 'note', r.note, 'dueAt', r.due_at) end,
    'canRemind', reach,
    'canBrowse', m.reply_to = 'OWNER' and companion_private.feature_on('COMPANION_WEB'),
    'reminders', case when reach then coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'dueAt', q.due_at, 'note', q.note)
        order by q.due_at, q.id)
      from (select * from companion_private.chat_reminders w where w.companion_id = m.companion_id and w.status = 'WAITING'
        and w.turn_id is null and w.due_at > now() - interval '24 hours' order by w.due_at, w.id limit 20) q), '[]') else '[]'::jsonb end)
    || companion_private.chat_owner_context(c.owner_id, m.companion_id);
end $$;

-- As in 0074, plus images: the paths of a message's pictures (the files are not in the export; the
-- app can fetch them).
create or replace function companion_private.export_messages(p_chat uuid, p_from timestamptz)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'messages', coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'at', m.shown_at, 'companionId', m.companion_id, 'body', m.body,
        'action', m.action, 'voice', exists(select 1 from companion_private.chat_audio a where a.message_id = m.id),
        'images', coalesce((select jsonb_agg(i.object_name order by i.position) from companion_private.chat_images i where i.message_id = m.id), '[]'),
        'reach', case m.reply_to when 'SELF' then 'GREETING' when 'REMINDER' then 'REMINDER' end) order by m.shown_at, m.id)
      filter (where p_from is null or m.shown_at >= p_from), '[]'),
    'omitted', count(*) filter (where m.shown_at < p_from))
  from companion_private.chat_messages m where m.chat_id = p_chat and m.status = 'SENT' and m.shown_at <= now()
$$;

revoke all on function public.media_is_chat(text), public.media_chat_unused(text), companion_private.chat_images_used(),
  public.chat_send(uuid, text, uuid[], text, jsonb), public.chat_image_seen(text, text),
  public.chat_reserve(uuid, uuid, text, text, text, text, bigint, bigint, bigint, text, text) from public, anon, authenticated;
-- The Storage service asks as the signed-in user, so the policy functions are theirs to call.
grant execute on function public.media_is_chat(text), public.media_chat_unused(text) to authenticated;
grant execute on function public.chat_send(uuid, text, uuid[], text, jsonb) to authenticated;
grant execute on function public.chat_image_seen(text, text),
  public.chat_reserve(uuid, uuid, text, text, text, text, bigint, bigint, bigint, text, text) to companion_api;

insert into companion_private.schema_migrations(name) values ('202611280086_chat_images');

commit;
