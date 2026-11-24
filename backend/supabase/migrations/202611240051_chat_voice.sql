begin;

-- Voice messages (语音): a Companion sometimes answers with a voice message instead of text,
-- like a person does, and the Owner can send voice messages too.
--
-- A voice message is an ordinary chat message (its body is the transcript, so the safety scan,
-- the diary and the model's own history keep working on text) plus one audio clip in chat_audio.
-- The Owner picks a voice per Companion (chat_settings.voice, an id from the API server's voice
-- catalog; null = text only). The model marks which of its messages to say aloud; the API server
-- turns those into speech and stores the clips with the reply in chat_finish.
--
-- Clips live in the database, next to the message: deleting a chat or a Companion deletes them
-- too, and no storage key is needed. They are small (about 4 KB per second) and kept for
-- chat_quota.voice_keep_days (default 30), then deleted; the message stays as text.
-- chat_quota.daily_voice caps how many clips one Owner gets per UTC day; past it, replies are text.
--
-- The Owner's own voice message: the app uploads the recording to the API server, which turns it
-- into text (speech recognition) and stores both with chat_send_voice. chat_quota.daily_owner_voice
-- caps how many the Owner sends per UTC day. Companions see "(语音)" before voice messages in the
-- conversation, so they answer a voice message with one more often.

alter table companion_private.chat_settings
  add column voice text check (voice is null or voice ~ '^[a-z0-9][a-z0-9-]{0,39}$');

alter table companion_private.chat_quota
  add column daily_voice integer not null default 60 check (daily_voice between 0 and 100000),
  add column voice_keep_days integer not null default 30 check (voice_keep_days between 1 and 3650),
  add column daily_owner_voice integer not null default 100 check (daily_owner_voice between 0 and 100000);

create table companion_private.chat_audio (
  message_id uuid primary key references companion_private.chat_messages(id) on delete cascade,
  -- The Owner's recordings come from phones (m4a/aac), the Companions' from the speech provider (mp3).
  mime text not null check (mime in ('audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg')),
  duration_ms integer not null check (duration_ms between 1 and 120000),
  -- What the speech provider billed for a Companion's clip (0 for the Owner's), for adding up usage later.
  characters integer not null check (characters between 0 and 100000),
  bytes bytea not null check (octet_length(bytes) between 1 and 1048576),
  created_at timestamptz not null default now()
);
create index chat_audio_created on companion_private.chat_audio(created_at);
alter table companion_private.chat_audio enable row level security;
alter table companion_private.chat_audio force row level security;
revoke all on companion_private.chat_audio from public, anon, authenticated;

-- Same as before, plus `audio` ({durationMs} for a voice message, else null).
create or replace function companion_private.chat_message_json(m companion_private.chat_messages)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body, 'action', m.action,
    'mentions', to_jsonb(m.mentions), 'status', m.status, 'failure', m.failure,
    'retryable', m.status = 'FAILED' and m.failure = 'ERROR', 'sentAt', m.shown_at,
    'audio', (select jsonb_build_object('durationMs', a.duration_ms) from companion_private.chat_audio a where a.message_id = m.id))
$$;

-- Same as before, plus `recording`: the Companions in `typing` whose next message is a voice message.
create or replace function companion_private.chat_progress(c companion_private.chats)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'typing', case when exists(select 1 from companion_private.chat_messages x where x.chat_id = c.id and x.status = 'SENT' and x.shown_at > now())
      then coalesce((select jsonb_agg(distinct x.companion_id) from companion_private.chat_messages x
        where x.chat_id = c.id and x.status = 'SENT' and x.typing_at <= now() and x.shown_at > now()), '[]')
      else coalesce((select case when not x.optional and x.typing_at <= now() then jsonb_build_array(x.companion_id) end
        from companion_private.chat_messages x
        join companion_private.chat_members m on m.chat_id = x.chat_id and m.companion_id = x.companion_id
        where x.chat_id = c.id and x.status = 'PENDING' order by x.created_at, m.position, x.id limit 1), '[]') end,
    'recording', coalesce((select jsonb_agg(distinct x.companion_id) from companion_private.chat_messages x
      join companion_private.chat_audio a on a.message_id = x.id
      where x.chat_id = c.id and x.status = 'SENT' and x.typing_at <= now() and x.shown_at > now()), '[]'),
    'replying', exists(select 1 from companion_private.chat_messages x where x.chat_id = c.id
      and (x.status = 'PENDING' or x.shown_at > now())))
$$;

create or replace function companion_private.chat_settings_json(s companion_private.chat_settings)
returns jsonb language sql immutable as $$
  select jsonb_build_object('groupActivity', s.group_activity, 'companionInteraction', s.companion_interaction,
    'model', s.model, 'voice', s.voice, 'revision', s.revision)
$$;

drop function public.chat_update_settings(uuid, text, text, text, integer);
-- Replaces every setting. A stale revision (another device saved first) is a conflict.
-- p_model and p_voice are checked against the catalogs by the API server; null means the
-- platform default model, and no voice (text only).
create function public.chat_update_settings(p_companion uuid, p_group_activity text, p_companion_interaction text,
  p_model text, p_voice text, p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.chat_settings%rowtype; o uuid := companion_private.chat_owner();
begin
  s := companion_private.chat_settings_for(p_companion);
  update companion_private.chat_settings set group_activity = p_group_activity,
    companion_interaction = p_companion_interaction, model = p_model, voice = p_voice, revision = revision + 1
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='chat settings revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'CHAT_UPDATE_SETTINGS', 'COMPANION', s.companion_id);
  return companion_private.chat_settings_json(s);
end $$;

-- The Owner's audio for one shown voice message: {mime, durationMs, data (base64)}.
create function public.chat_audio_get(p_chat uuid, p_message uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c companion_private.chats%rowtype; a companion_private.chat_audio%rowtype;
begin
  c := companion_private.chat_for(p_chat);
  select x.* into a from companion_private.chat_audio x join companion_private.chat_messages m on m.id = x.message_id
    where m.id = p_message and m.chat_id = c.id and m.status = 'SENT' and m.shown_at <= now();
  if not found then raise exception using errcode='P0001', message='audio not found'; end if;
  return jsonb_build_object('mime', a.mime, 'durationMs', a.duration_ms, 'data', encode(a.bytes, 'base64'));
end $$;

-- ---------- for the API server only (companion_api) ----------

-- Voice messages the signed-in Owner sent today (UTC): p_owner true; or got from Companions: false.
create function companion_private.chat_voice_used(p_owner boolean)
returns bigint language sql stable security definer set search_path='' as $$
  select count(*) from companion_private.chat_audio a
    join companion_private.chat_messages m on m.id = a.message_id
    join companion_private.chats c on c.id = m.chat_id
  where c.owner_id = companion_private.chat_owner() and (m.companion_id is null) = p_owner
    and a.created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
$$;

-- How many voice messages the signed-in Owner may still get from Companions today (UTC), and
-- send: {"left": n, "ownerLeft": n}.
create function public.chat_voice_left()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('left', greatest(0, q.daily_voice - companion_private.chat_voice_used(false)),
    'ownerLeft', greatest(0, q.daily_owner_voice - companion_private.chat_voice_used(true)))
  from companion_private.chat_quota q
  where companion_private.chat_owner() is not null
$$;

-- The Owner's voice message: p_body is what the API server recognised, p_audio the recording
-- {mime, durationMs, data (base64)}. Otherwise like chat_send (no @mentions). A retry with the same
-- key returns the first message even if recognition came out differently this time.
create function public.chat_send_voice(p_chat uuid, p_body text, p_key text, p_audio jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; sent jsonb;
begin
  c := companion_private.chat_for(p_chat);
  select * into m from companion_private.chat_messages where chat_id = c.id and key_hash = p_key;
  if found then
    return jsonb_build_object('message', companion_private.chat_message_json(m)) || companion_private.chat_progress(c);
  end if;
  if p_audio is null or jsonb_typeof(p_audio) <> 'object' then
    raise exception using errcode='22023', message='invalid voice message';
  end if;
  if companion_private.chat_voice_used(true) >= (select daily_owner_voice from companion_private.chat_quota) then
    raise exception using errcode='55000', message='voice message limit reached';
  end if;
  sent := public.chat_send(p_chat, p_body, '{}', p_key);
  insert into companion_private.chat_audio(message_id, mime, duration_ms, characters, bytes)
    values ((sent -> 'message' ->> 'id')::uuid, p_audio ->> 'mime', (p_audio ->> 'durationMs')::integer, 0,
      decode(p_audio ->> 'data', 'base64'));
  select * into m from companion_private.chat_messages where id = (sent -> 'message' ->> 'id')::uuid;
  return sent || jsonb_build_object('message', companion_private.chat_message_json(m));
end $$;

-- Same as before, plus `voice` in the history (a voice message), so a Companion knows when the
-- Owner spoke rather than typed.
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
    'history', coalesce((select jsonb_agg(jsonb_build_object('companionId', q.companion_id, 'body', q.body, 'action', q.action,
        'mentions', to_jsonb(q.mentions), 'sentAt', q.shown_at,
        'voice', exists(select 1 from companion_private.chat_audio a where a.message_id = q.id)) order by q.shown_at, q.id)
      from (select * from companion_private.chat_messages h where h.chat_id = c.id and h.status = 'SENT'
        -- Actions in a row read as the last of them, so taps cannot push the conversation out of the 30.
        and (h.action is null or (select n.action from companion_private.chat_messages n
          where n.chat_id = h.chat_id and n.status = 'SENT' and (n.shown_at, n.id) > (h.shown_at, h.id)
          order by n.shown_at, n.id limit 1) is null)
        order by h.shown_at desc, h.id desc limit 30) q), '[]'));
end $$;

drop function public.chat_finish(uuid, uuid, text, text[]);
-- Same as before, plus p_audio: for SENT, null (all text) or one entry per message, each null
-- (text) or {mime, durationMs, characters, data (base64)} (a voice message, shown after about as
-- long as it takes to say). Clips past chat_quota.voice_keep_days are deleted here, a few at a time.
create function public.chat_finish(p_reply uuid, p_claim uuid, p_outcome text, p_bodies text[], p_audio jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid;
  v_bodies text[] := array(select btrim(b) from unnest(p_bodies) b); n integer := coalesce(cardinality(p_bodies), 0);
  pause interval := companion_private.chat_seconds(0.6); start_at timestamptz; done_at timestamptz; i integer;
  failed boolean := p_outcome in ('ERROR', 'UNAVAILABLE', 'DISABLED', 'QUOTA');
  clip jsonb; v_id uuid; keep integer;
begin
  if p_outcome is null or p_outcome not in ('SENT', 'PASSED', 'BLOCKED', 'ERROR', 'UNAVAILABLE', 'DISABLED', 'QUOTA')
    or (p_outcome = 'SENT') <> (p_bodies is not null)
    or (p_outcome = 'SENT' and (n < 1 or n > 3 or exists(select 1 from unnest(v_bodies) b
      where b is null or b !~ '\S' or char_length(b) > 2000)))
    or (p_audio is not null and (p_outcome <> 'SENT' or jsonb_typeof(p_audio) <> 'array' or jsonb_array_length(p_audio) <> n
      or exists(select 1 from jsonb_array_elements(p_audio) e where jsonb_typeof(e) not in ('null', 'object')))) then
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
      clip := case when p_audio is null or jsonb_typeof(p_audio -> (i - 1)) = 'null' then null else p_audio -> (i - 1) end;
      -- Typing takes longer for longer text; recording a voice message takes as long as saying it.
      done_at := greatest(now(), start_at + companion_private.chat_seconds(case when clip is null
        then least(6, greatest(1, 0.8 + 0.08 * char_length(v_bodies[i])))
        else least(30, greatest(1, (clip ->> 'durationMs')::numeric / 1000)) end));
      if i = 1 then
        update companion_private.chat_messages set status = 'SENT', body = v_bodies[1], typing_at = start_at,
          shown_at = done_at, claim_id = null, compute_tx = null where id = m.id;
        v_id := m.id;
      else
        insert into companion_private.chat_messages(chat_id, companion_id, body, status, reply_to, optional, part,
            created_at, typing_at, shown_at)
          values (c.id, m.companion_id, v_bodies[i], 'SENT', m.reply_to, m.optional, i, m.created_at, start_at, done_at)
          returning id into v_id;
      end if;
      if clip is not null then
        insert into companion_private.chat_audio(message_id, mime, duration_ms, characters, bytes)
          values (v_id, clip ->> 'mime', (clip ->> 'durationMs')::integer, (clip ->> 'characters')::integer,
            decode(clip ->> 'data', 'base64'));
      end if;
      start_at := done_at + pause;
    end loop;
    select voice_keep_days into keep from companion_private.chat_quota;
    delete from companion_private.chat_audio where message_id in (select message_id from companion_private.chat_audio
      where created_at < now() - make_interval(days => keep) order by created_at limit 20);
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

revoke all on function public.chat_update_settings(uuid, text, text, text, text, integer), public.chat_audio_get(uuid, uuid),
  public.chat_voice_left(), public.chat_send_voice(uuid, text, text, jsonb), public.chat_finish(uuid, uuid, text, text[], jsonb),
  companion_private.chat_voice_used(boolean) from public, anon, authenticated;
grant execute on function public.chat_update_settings(uuid, text, text, text, text, integer), public.chat_audio_get(uuid, uuid)
  to authenticated;
-- Only the API server writes a Companion's words and its voice, and turns the Owner's recordings into text.
grant execute on function public.chat_voice_left(), public.chat_send_voice(uuid, text, text, jsonb),
  public.chat_finish(uuid, uuid, text, text[], jsonb) to companion_api;

commit;
