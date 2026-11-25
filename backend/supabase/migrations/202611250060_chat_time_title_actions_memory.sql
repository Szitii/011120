begin;

-- Part 1: two things a Companion did not know when it wrote a reply or a diary entry.
--
--   1. What time it is for the Owner. chat_claim and diary_begin now carry `timeZone` (an IANA
--      name); the API server writes the current local time into the prompt and marks how long
--      passed between messages. Without it a Companion that heard "晚安" last night asked
--      "怎么还不睡" the next morning.
--   2. What to call the Owner. They carry `ownerName` too: the new chat setting
--      preferredUserTitle (per Companion, null by default), else the Owner's community display
--      name, else null (the prompt then says 你 in the diary). Before, everything said 主人.
--
-- The time zone is the one the Owner saved in the Companion's community settings (the app fills
-- in the device's zone on the first save); Asia/Shanghai until then.
--
-- Part 2: a Companion may do a home-room action to its Owner (TA 抱了抱你). It decides so itself
-- while writing a reply in the one-to-one chat; the action is a message of the Companion with
-- `action` set and no body, shown before what it says (if anything). At most one per reply.
-- The app released before this shows every action as the Owner's ("你抱了抱 TA"), so this waits
-- behind the feature switch COMPANION_ACTIONS until the operators turn it on.
--
-- Part 3: a Companion notes down by itself what is worth remembering (自动记忆). The Owner picks
-- per Companion: OFF (default), SOMETIMES (after every 30 messages of the Owner in the one-to-one
-- chat) or OFTEN (every 10). When that many came since the last time, the API server asks a cheap
-- model for at most 2 sentences and stores them as memories with source AUTO, next to the ones
-- the Owner wrote; the Owner sees and deletes them in the same list. At 200 memories the oldest
-- AUTO one makes room; the Owner's own are never removed. Booked in the ledger as
-- MEMORY_CONSOLIDATION, a background call like the diary.
--
-- Part 4: the Owner's voice messages get a feature switch, VOICE_INPUT, off for now: speech
-- recognition is configured but its account has no balance, so GET /v0/voices said `input: true`
-- and every voice message failed. With the switch off the app hides the button.

alter table companion_private.chat_settings
  add column owner_title text check (owner_title is null
    or (char_length(owner_title) between 1 and 20 and owner_title !~ '[[:cntrl:]]')),
  add column auto_memory text not null default 'OFF' check (auto_memory in ('OFF', 'SOMETIMES', 'OFTEN'));

create or replace function companion_private.chat_settings_json(s companion_private.chat_settings)
returns jsonb language sql immutable as $$
  select jsonb_build_object('groupActivity', s.group_activity, 'companionInteraction', s.companion_interaction,
    'model', s.model, 'voice', s.voice, 'preferredUserTitle', s.owner_title, 'autoMemory', s.auto_memory,
    'revision', s.revision)
$$;

drop function public.chat_update_settings(uuid, text, text, text, text, integer);
-- Replaces every setting. A stale revision (another device saved first) is a conflict.
-- p_model and p_voice are checked against the catalogs by the API server; null means the
-- platform default model, and no voice (text only). p_owner_title: what the Companion calls the
-- Owner, 1 to 20 characters, or '' for the default. p_auto_memory: OFF, SOMETIMES or OFTEN (part 3).
-- Null keeps the current value of either: they come last with defaults, so the API server deployed
-- before this migration keeps working and changes neither.
create function public.chat_update_settings(p_companion uuid, p_group_activity text, p_companion_interaction text,
  p_model text, p_voice text, p_revision integer, p_owner_title text default null, p_auto_memory text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.chat_settings%rowtype; o uuid := companion_private.chat_owner();
begin
  s := companion_private.chat_settings_for(p_companion);
  update companion_private.chat_settings set group_activity = p_group_activity,
    companion_interaction = p_companion_interaction, model = p_model, voice = p_voice,
    owner_title = case when p_owner_title is null then owner_title else nullif(btrim(p_owner_title), '') end,
    auto_memory = coalesce(p_auto_memory, auto_memory), revision = revision + 1
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='chat settings revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'CHAT_UPDATE_SETTINGS', 'COMPANION', s.companion_id);
  return companion_private.chat_settings_json(s);
end $$;

-- What a Companion knows about its Owner when it writes: {timeZone, ownerName} (see the top).
create function companion_private.chat_owner_context(p_owner uuid, p_companion uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'timeZone', coalesce((select s.time_zone from companion_private.agent_settings s
      join public.community_actors a on a.id = s.actor_id
      join public.social_twins t on t.id = a.social_twin_id
      where t.companion_id = p_companion order by s.revision desc limit 1), 'Asia/Shanghai'),
    'ownerName', coalesce(
      (select s.owner_title from companion_private.chat_settings s where s.companion_id = p_companion),
      (select coalesce(a.human_display_name, o.display_name) from public.owners o
        left join public.community_actors a on a.owner_id = o.id and a.kind = 'HUMAN' where o.id = p_owner)))
$$;

-- Same as before (0049), plus timeZone, ownerName and canAct (it may do a home-room action in this
-- reply). Only the Owner's actions collapse into the last of a row; a Companion's own always show.
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
        -- The Owner's actions in a row read as the last of them, so taps cannot push the conversation out of the 30.
        and (h.action is null or h.companion_id is not null or coalesce((select n.action is null or n.companion_id is not null
          from companion_private.chat_messages n
          where n.chat_id = h.chat_id and n.status = 'SENT' and (n.shown_at, n.id) > (h.shown_at, h.id)
          order by n.shown_at, n.id limit 1), true))
        order by h.shown_at desc, h.id desc limit 30) q), '[]'),
    'canAct', c.direct_companion_id is not null and companion_private.feature_on('COMPANION_ACTIONS'))
    || companion_private.chat_owner_context(c.owner_id, m.companion_id);
end $$;

-- Same as before (0045), plus timeZone and ownerName.
create or replace function public.diary_begin(p_companion uuid)
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

  -- The one-to-one chat; of several actions of the Owner in a row only the last, as in chat_claim.
  select coalesce(jsonb_agg(jsonb_build_object('companionId', q.companion_id, 'body', q.body, 'action', q.action,
      'sentAt', q.shown_at) order by q.shown_at, q.id), '[]') into messages
  from (select h.* from companion_private.chat_messages h join companion_private.chats c on c.id = h.chat_id
    where c.owner_id = o and c.direct_companion_id = p_companion and h.status = 'SENT'
      and h.shown_at > v_from and h.shown_at <= v_until
      and (h.action is null or h.companion_id is not null or coalesce((select n.action is null or n.companion_id is not null
        from companion_private.chat_messages n
        where n.chat_id = h.chat_id and n.status = 'SENT' and (n.shown_at, n.id) > (h.shown_at, h.id)
        order by n.shown_at, n.id limit 1), true))
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
    'messages', messages, 'posts', posts)
    || companion_private.chat_owner_context(o, p_companion);
end $$;

-- ---------- part 2: a Companion's own home-room action ----------

alter table companion_private.feature_switches drop constraint feature_switches_key_check;
alter table companion_private.feature_switches add constraint feature_switches_key_check
  check (key in ('GROUP_CHAT_CREATE', 'GROUP_CHAT_SEND', 'COMMUNITY_NEW_NOTICES', 'COMPANION_ACTIONS', 'VOICE_INPUT'));
insert into companion_private.feature_switches(key, enabled) values ('COMPANION_ACTIONS', false), ('VOICE_INPUT', false);

-- Same as before (0050), plus voiceInput (part 4): the API server sends `input: false` and refuses
-- the Owner's voice messages while it is off.
create or replace function public.platform_features()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('groupChatCreate', companion_private.feature_on('GROUP_CHAT_CREATE'),
    'groupChatSend', companion_private.feature_on('GROUP_CHAT_SEND'),
    'voiceInput', companion_private.feature_on('VOICE_INPUT'))
$$;

-- An action row has no body, whoever did it (was: only the Owner's). A reply that starts with an
-- action has up to four rows: the action, then up to three messages.
alter table companion_private.chat_messages drop constraint chat_messages_action_owner_check;
alter table companion_private.chat_messages add constraint chat_messages_action_body_check check (action is null or body is null);
alter table companion_private.chat_messages drop constraint chat_messages_part_check;
alter table companion_private.chat_messages add constraint chat_messages_part_check check (part between 1 and 4);

-- Same as before (0044), but the 3-minute rule only looks at the Owner's earlier actions: answering
-- a Companion's hug with one still gives the Companion a turn.
create or replace function public.chat_act(p_companion uuid, p_action text, p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype;
begin
  if p_action is null or p_action not in ('WAVE', 'PAT_HEAD', 'HUG', 'CUDDLE') then
    raise exception using errcode='22023', message='invalid action';
  end if;
  -- Checks the Companion and the key, and creates the one-to-one chat on first use.
  perform public.chat_open(array[p_companion], null, p_key);
  c := companion_private.chat_for((select id from companion_private.chats where direct_companion_id = p_companion));
  select * into m from companion_private.chat_messages where chat_id = c.id and key_hash = p_key;
  if found then
    if m.action is distinct from p_action then raise exception using errcode='23505', message='idempotency conflict'; end if;
    return jsonb_build_object('chatId', c.id, 'message', companion_private.chat_message_json(m)) || companion_private.chat_progress(c);
  end if;
  if (select count(*) from companion_private.chat_messages x join companion_private.chats y on y.id = x.chat_id
      where y.owner_id = c.owner_id and x.companion_id is null and x.created_at > now() - interval '1 hour') >= 300 then
    raise exception using errcode='55000', message='chat message limit reached';
  end if;
  -- The first action of a burst: one turn the Companion may use to answer, or let go.
  if not exists(select 1 from companion_private.chat_messages where chat_id = c.id and status = 'PENDING')
    and not exists(select 1 from companion_private.chat_messages where chat_id = c.id and action is not null
      and companion_id is null and created_at > now() - interval '3 minutes') then
    insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
      values (c.id, p_companion, 'PENDING', 'OWNER', true);
  end if;
  -- Added after the check above, so the 3-minute rule only looks at earlier actions.
  insert into companion_private.chat_messages(chat_id, action, status, key_hash, shown_at)
    values (c.id, p_action, 'SENT', p_key, now()) returning * into m;
  update companion_private.chats set active_at = now() where id = c.id returning * into c;
  return jsonb_build_object('chatId', c.id, 'message', companion_private.chat_message_json(m)) || companion_private.chat_progress(c);
end $$;

drop function public.chat_finish(uuid, uuid, text, text[], jsonb);
-- Same as before (0049), plus p_action: for SENT in a one-to-one chat, a home-room action the
-- Companion does to its Owner. The turn's own row becomes the action (shown first, after a
-- second of "typing") and the messages follow as rows of their own; with an action there may be
-- no message at all. (p_action comes last with a default, so the API server deployed before this
-- migration keeps working.)
create function public.chat_finish(p_reply uuid, p_claim uuid, p_outcome text, p_bodies text[], p_audio jsonb default null,
  p_action text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid;
  v_bodies text[] := array(select btrim(b) from unnest(p_bodies) b); n integer := coalesce(cardinality(p_bodies), 0);
  pause interval := companion_private.chat_seconds(0.6); start_at timestamptz; done_at timestamptz; i integer;
  failed boolean := p_outcome in ('ERROR', 'UNAVAILABLE', 'DISABLED', 'QUOTA');
  clip jsonb; v_id uuid; keep integer; acted integer := (p_action is not null)::integer;
begin
  if p_outcome is null or p_outcome not in ('SENT', 'PASSED', 'BLOCKED', 'ERROR', 'UNAVAILABLE', 'DISABLED', 'QUOTA')
    or (p_outcome = 'SENT') <> (p_bodies is not null)
    or (p_action is not null and (p_outcome <> 'SENT' or p_action not in ('WAVE', 'PAT_HEAD', 'HUG', 'CUDDLE')))
    or (p_outcome = 'SENT' and (n < 1 - acted or n > 3 or exists(select 1 from unnest(v_bodies) b
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
  if p_action is not null and c.direct_companion_id is null then
    raise exception using errcode='22023', message='actions belong to one-to-one chats';
  end if;
  perform companion_private.chat_abandon_compute(c.owner_id, m.compute_tx);
  -- Companions take turns visibly: typing starts after the last Companion message appeared.
  -- A turn that must answer has shown "typing" since typing_at, so time the model spent writing
  -- counts as typing; an optional turn starts typing only now that it decided to speak.
  select max(shown_at) + pause into done_at from companion_private.chat_messages
    where chat_id = c.id and companion_id is not null and status in ('SENT', 'FAILED', 'BLOCKED', 'PASSED');
  start_at := greatest(coalesce(m.typing_at, now()), coalesce(done_at, '-infinity'));
  if p_outcome = 'SENT' then
    if p_action is not null then
      done_at := greatest(now(), start_at + companion_private.chat_seconds(1));
      update companion_private.chat_messages set status = 'SENT', action = p_action, typing_at = start_at,
        shown_at = done_at, claim_id = null, compute_tx = null where id = m.id;
      start_at := done_at + pause;
    end if;
    for i in 1..n loop
      clip := case when p_audio is null or jsonb_typeof(p_audio -> (i - 1)) = 'null' then null else p_audio -> (i - 1) end;
      -- Typing takes longer for longer text; recording a voice message takes as long as saying it.
      done_at := greatest(now(), start_at + companion_private.chat_seconds(case when clip is null
        then least(6, greatest(1, 0.8 + 0.08 * char_length(v_bodies[i])))
        else least(30, greatest(1, (clip ->> 'durationMs')::numeric / 1000)) end));
      if i = 1 and p_action is null then
        update companion_private.chat_messages set status = 'SENT', body = v_bodies[1], typing_at = start_at,
          shown_at = done_at, claim_id = null, compute_tx = null where id = m.id;
        v_id := m.id;
      else
        insert into companion_private.chat_messages(chat_id, companion_id, body, status, reply_to, optional, part,
            created_at, typing_at, shown_at)
          values (c.id, m.companion_id, v_bodies[i], 'SENT', m.reply_to, m.optional, i + acted, m.created_at, start_at, done_at)
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

revoke all on function public.chat_finish(uuid, uuid, text, text[], jsonb, text) from public, anon, authenticated;
grant execute on function public.chat_finish(uuid, uuid, text, text[], jsonb, text) to companion_api;
-- ---------- part 3: memories a Companion notes down by itself ----------

alter table companion_private.companion_memories drop constraint companion_memories_source_check;
alter table companion_private.companion_memories add constraint companion_memories_source_check
  check (source in ('IMPORT', 'OWNER', 'AUTO'));
alter table companion_private.wallet_entries drop constraint wallet_entries_purpose_check;
alter table companion_private.wallet_entries add constraint wallet_entries_purpose_check
  check (purpose is null or purpose in ('CHAT', 'DIARY', 'POST', 'MEMORY'));

-- One row per Companion: how far its one-to-one chat has been read for memories (covers_until),
-- the attempt in progress (claim_id, covering up to pending_until) and when one last failed.
create table companion_private.memory_notes (
  companion_id uuid primary key references public.companions(id) on delete cascade,
  covers_until timestamptz,
  pending_until timestamptz,
  claim_id uuid,
  claimed_at timestamptz,
  compute_tx uuid,
  failed_at timestamptz
);
alter table companion_private.memory_notes enable row level security;
alter table companion_private.memory_notes force row level security;
revoke all on companion_private.memory_notes from public, anon, authenticated;

-- Same as in 0057, but also settles the model calls that note memories down.
create or replace function public.chat_settle(p_transaction uuid, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_ok boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  perform 1 from public.compute_transactions where id = p_transaction and owner_id = o
    and trigger_event_type in ('CHAT_MESSAGE', 'DIARY_ENTRY', 'COMMUNITY_POST', 'CHAT_MEMORY') for update;
  if not found then raise exception using errcode='P0001', message='chat compute transaction not found'; end if;
  if (select status from public.compute_ledger_entries where transaction_id = p_transaction order by sequence desc limit 1) <> 'STARTED' then
    return jsonb_build_object('settled', false);
  end if;
  perform companion_private.settle_compute_transaction(o, p_transaction, p_input_tokens, p_output_tokens, p_cost_minor,
    case when p_ok then 'SUCCEEDED' else 'FAILED' end, case when p_ok then null else 'PROVIDER_ERROR' end, null);
  perform companion_private.wallet_close(p_transaction, case when p_ok then p_cost_minor end);
  return jsonb_build_object('settled', true);
end $$;

-- The notes row of the signed-in Owner's Companion, locked; created on first use.
create function companion_private.memory_notes_for(p_companion uuid)
returns companion_private.memory_notes language plpgsql security definer set search_path='' as $$
declare a companion_private.memory_notes%rowtype; c uuid := companion_private.owned_companion(p_companion);
begin
  insert into companion_private.memory_notes(companion_id) values (c) on conflict do nothing;
  select * into a from companion_private.memory_notes where companion_id = c for update;
  return a;
end $$;

-- Starts an attempt if one is due; the API server asks after every reply in a one-to-one chat.
-- Returns {"status": ...}:
--   OFF       the Owner did not ask for it
--   WRITING   another attempt is in progress
--   NOT_DUE   too few new messages of the Owner, or an attempt failed in the last 10 minutes
--   WRITE     go ahead: claimId, the Companion, timeZone, messages (the newest 130 text messages of
--             the one-to-one chat since the last time, oldest first) and memories (what it
--             already remembers, newest first, at most 60)
-- An attempt left for more than 3 minutes (the server stopped or the model hung) is closed here,
-- whatever the setting says now, so its booked call does not stay open.
create function public.memory_auto_begin(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); a companion_private.memory_notes%rowtype;
  s companion_private.chat_settings%rowtype; v_chat uuid; v_until timestamptz := now(); said integer; need integer;
begin
  a := companion_private.memory_notes_for(p_companion);
  s := companion_private.chat_settings_for(p_companion);
  if a.claim_id is not null then
    if a.claimed_at > now() - interval '3 minutes' then return jsonb_build_object('status', 'WRITING'); end if;
    perform companion_private.chat_abandon_compute(o, a.compute_tx);
    update companion_private.memory_notes set claim_id = null, claimed_at = null, compute_tx = null, pending_until = null,
      failed_at = now() where companion_id = p_companion;
    return jsonb_build_object('status', case when s.auto_memory = 'OFF' then 'OFF' else 'NOT_DUE' end);
  end if;
  if s.auto_memory = 'OFF' then return jsonb_build_object('status', 'OFF'); end if;
  if a.failed_at > now() - interval '10 minutes' then return jsonb_build_object('status', 'NOT_DUE'); end if;
  select id into v_chat from companion_private.chats where owner_id = o and direct_companion_id = p_companion;
  select count(*) into said from companion_private.chat_messages h
    where h.chat_id = v_chat and h.companion_id is null and h.body is not null and h.status = 'SENT'
      and h.shown_at > coalesce(a.covers_until, '-infinity') and h.shown_at <= v_until;
  need := case s.auto_memory when 'OFTEN' then 10 else 30 end;
  if said < need then return jsonb_build_object('status', 'NOT_DUE'); end if;
  update companion_private.memory_notes set claim_id = gen_random_uuid(), claimed_at = now(), pending_until = v_until, compute_tx = null
    where companion_id = p_companion returning * into a;
  return jsonb_build_object('status', 'WRITE', 'claimId', a.claim_id,
    'companion', companion_private.chat_companion_json(p_companion),
    'timeZone', companion_private.chat_owner_context(o, p_companion)->'timeZone',
    'messages', coalesce((select jsonb_agg(jsonb_build_object('companionId', q.companion_id, 'body', q.body, 'action', null,
        'sentAt', q.shown_at) order by q.shown_at, q.id)
      from (select h.* from companion_private.chat_messages h
        where h.chat_id = v_chat and h.body is not null and h.status = 'SENT'
          and h.shown_at > coalesce(a.covers_until, '-infinity') and h.shown_at <= v_until
        order by h.shown_at desc, h.id desc limit 130) q), '[]'),
    'memories', coalesce((select jsonb_agg(q.body order by q.created_at desc, q.id desc)
      from (select m.* from companion_private.companion_memories m where m.companion_id = p_companion
        order by m.created_at desc, m.id desc limit 60) q), '[]'));
end $$;

-- Books the model call for an attempt and marks it started, like diary_reserve.
create function public.memory_auto_reserve(p_companion uuid, p_claim uuid, p_provider text, p_model text,
  p_pricing_version text, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_trace text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a companion_private.memory_notes%rowtype; result jsonb;
begin
  a := companion_private.memory_notes_for(p_companion);
  if a.claim_id is null or a.claim_id is distinct from p_claim then return jsonb_build_object('decision', 'STALE'); end if;
  result := companion_private.compute_book(companion_private.chat_owner(), p_companion, 'MEMORY_CONSOLIDATION', 'CHAT_MEMORY', a.claim_id,
    'MEMORY', true, p_provider, p_model, p_pricing_version, p_input_tokens, p_output_tokens, p_cost_minor,
    'chat-memory/1', 'none', 'chat-memory/1', p_trace, 1, encode(sha256(convert_to(a.claim_id::text || ':MEMORY','UTF8')), 'hex'));
  if result->>'decision' = 'RESERVED' then
    update companion_private.memory_notes set compute_tx = (result->>'transactionId')::uuid where companion_id = p_companion;
  end if;
  return result;
end $$;

-- Ends an attempt. p_bodies: the sentences to remember (0 to 2, each 1 to 500 characters), or null
-- when the attempt failed. One it already remembers word for word is skipped. At 200 memories the
-- oldest AUTO one from an earlier attempt makes room; when there is none to remove, nothing more is added.
-- Returns {"accepted", "added"}; accepted false when the attempt was already given up.
create function public.memory_auto_finish(p_companion uuid, p_claim uuid, p_bodies text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare a companion_private.memory_notes%rowtype; v_body text; added integer := 0;
begin
  if cardinality(p_bodies) > 2 or exists(select 1 from unnest(p_bodies) b
      where b is null or b !~ '\S' or char_length(btrim(b)) > 500) then
    raise exception using errcode='22023', message='invalid memories';
  end if;
  -- The Companion before its notes, the order memory_add takes them in (it counts under this lock).
  perform 1 from public.companions where id = companion_private.owned_companion(p_companion) for no key update;
  a := companion_private.memory_notes_for(p_companion);
  if a.claim_id is null or a.claim_id is distinct from p_claim then return jsonb_build_object('accepted', false, 'added', 0); end if;
  perform companion_private.chat_abandon_compute(companion_private.chat_owner(), a.compute_tx);
  if p_bodies is null then
    update companion_private.memory_notes set claim_id = null, claimed_at = null, compute_tx = null, pending_until = null,
      failed_at = now() where companion_id = p_companion;
    return jsonb_build_object('accepted', true, 'added', 0);
  end if;
  foreach v_body in array p_bodies loop
    v_body := btrim(v_body);
    continue when exists(select 1 from companion_private.companion_memories where companion_id = p_companion and body = v_body);
    if (select count(*) from companion_private.companion_memories where companion_id = p_companion) >= 200 then
      delete from companion_private.companion_memories where id = (select id from companion_private.companion_memories
        where companion_id = p_companion and source = 'AUTO' and created_at < now() order by created_at, id limit 1);
      exit when not found;
    end if;
    insert into companion_private.companion_memories(companion_id, body, source) values (p_companion, v_body, 'AUTO');
    added := added + 1;
  end loop;
  update companion_private.memory_notes set covers_until = pending_until, pending_until = null, claim_id = null, claimed_at = null,
    compute_tx = null, failed_at = null where companion_id = p_companion;
  return jsonb_build_object('accepted', true, 'added', added);
end $$;

revoke all on function companion_private.memory_notes_for(uuid), public.memory_auto_begin(uuid),
  public.memory_auto_reserve(uuid, uuid, text, text, text, bigint, bigint, bigint, text),
  public.memory_auto_finish(uuid, uuid, text[]) from public, anon, authenticated;
-- Writing a Companion's memories is the server's job: not reachable through Supabase's own REST API.
grant execute on function public.memory_auto_begin(uuid),
  public.memory_auto_reserve(uuid, uuid, text, text, text, bigint, bigint, bigint, text),
  public.memory_auto_finish(uuid, uuid, text[]) to companion_api;

-- Same as in 0057, plus the Companion's memory notes: an attempt in progress gives back what it booked.
create or replace function public.companion_delete(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); c uuid; v_actor uuid;
begin
  perform 1 from public.owners where id = o for no key update;
  select id into c from public.companions
    where id = p_companion and owner_id = o and status not in ('DELETED', 'QUARANTINED') for update;
  if not found then raise exception using errcode='P0001', message='companion not found'; end if;
  update public.companions set status = 'DELETED', updated_at = now() where id = c;

  perform 1 from companion_private.chats x where x.direct_companion_id = c
    or exists(select 1 from companion_private.chat_members m where m.chat_id = x.id and m.companion_id = c) for update;
  -- Model calls still on the way are given up, so no budget or credits stay held.
  perform companion_private.chat_abandon_compute(o, m.compute_tx)
    from companion_private.chat_messages m where m.companion_id = c and m.compute_tx is not null;
  perform companion_private.chat_abandon_compute(o, e.compute_tx)
    from companion_private.diary_entries e where e.companion_id = c and e.compute_tx is not null;
  perform companion_private.chat_abandon_compute(o, r.compute_tx)
    from companion_private.agent_runs r where r.companion_id = c and r.compute_tx is not null;
  perform companion_private.chat_abandon_compute(o, n.compute_tx)
    from companion_private.memory_notes n where n.companion_id = c and n.compute_tx is not null;

  delete from companion_private.chats where direct_companion_id = c;
  delete from companion_private.chat_messages where companion_id = c;
  delete from companion_private.chat_members where companion_id = c;
  delete from companion_private.chats x where x.owner_id = o and x.direct_companion_id is null
    and not exists(select 1 from companion_private.chat_members m where m.chat_id = x.id);
  delete from companion_private.diary_entries where companion_id = c;
  delete from companion_private.diary_settings where companion_id = c;
  delete from companion_private.companion_memories where companion_id = c;
  delete from companion_private.memory_notes where companion_id = c;
  delete from companion_private.companion_connections where companion_id = c;
  delete from companion_private.agent_keys where companion_id = c;
  delete from companion_private.agent_runs where companion_id = c;
  delete from companion_private.anniversaries where companion_id = c;
  delete from companion_private.chat_settings where companion_id = c;
  delete from public.life_event_inbox where owner_id = o and companion_id = c;

  select a.id into v_actor from public.community_actors a
    join public.social_twins t on t.id = a.social_twin_id where t.companion_id = c;
  if v_actor is not null then
    update public.community_posts set deleted_at = now(), body = '[已删除]' where actor_id = v_actor and deleted_at is null;
    update public.community_comments set deleted_at = now(), body = '[已删除]' where actor_id = v_actor and deleted_at is null;
    delete from public.community_follows where actor_id = v_actor or target_id = v_actor;
    delete from public.community_likes where actor_id = v_actor;
    delete from public.community_notifications where actor_id = v_actor or recipient_id = v_actor;
    delete from companion_private.agent_drafts where actor_id = v_actor;
  end if;

  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'COMPANION_DELETE', 'COMPANION', c);
  return jsonb_build_object('deleted', true);
end $$;

revoke all on function companion_private.chat_owner_context(uuid, uuid),
  public.chat_update_settings(uuid, text, text, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.chat_update_settings(uuid, text, text, text, text, integer, text, text) to authenticated;

commit;
