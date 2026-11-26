begin;

-- A Companion speaks first: it writes to its Owner on its own (主动发消息), and it reminds the
-- Owner of something at a time the Owner asked for (提醒).
--
-- Both are a turn in the one-to-one chat that answers nobody, queued by the API server's
-- scheduler and written like any other reply (chat_claim, the model, the safety scan,
-- chat_finish). chat_messages.reply_to says which: SELF (its own initiative) or REMINDER.
--
-- Writing on its own, per Companion, chat_settings.proactive: OFF (default), SOMETIMES or OFTEN.
-- A turn is queued when all of this holds (chat_greeting_due):
--   * it is between 8:00 and 23:00 for the Owner;
--   * the Owner last wrote or did something in this chat at least 8 hours ago (SOMETIMES) or 3
--     (OFTEN), plus up to as long again (a fixed amount per message, so it does not come like
--     clockwork), and at most 7 days ago: someone who left is not written to forever;
--   * nothing is waiting to be answered in the chat;
--   * the Companion has not already written on its own since the Owner's last message: one
--     message left unanswered is where it stops (no nagging);
--   * its last attempt (it may decide to say nothing) was at least that many hours ago;
--   * it has written on its own less than once (SOMETIMES) or twice (OFTEN) today.
-- The turn may stay quiet, and a failed one just stays quiet.
--
-- Reminders: while it answers in the one-to-one chat the Companion may set one ("明天 8 点叫我":
-- the API server reads a mark in its reply and hands {at, note} to chat_finish) and may cancel
-- ones it set. At that time a REMINDER turn is queued, whatever the hour and whatever `proactive`
-- says: the Owner asked for it. At most 20 wait per Companion. One that could not be delivered
-- within a day, or in 5 tries, is given up (MISSED). They go with the chat when it is deleted.
--
-- The operators' switch COMPANION_REACH (on) stops both.

-- ---------- the setting and the switch ----------

alter table companion_private.chat_settings
  add column proactive text not null default 'OFF' check (proactive in ('OFF', 'SOMETIMES', 'OFTEN'));

create or replace function companion_private.chat_settings_json(s companion_private.chat_settings)
returns jsonb language sql immutable as $$
  select jsonb_build_object('groupActivity', s.group_activity, 'companionInteraction', s.companion_interaction,
    'model', s.model, 'voice', s.voice, 'preferredUserTitle', s.owner_title, 'autoMemory', s.auto_memory,
    'proactive', s.proactive, 'revision', s.revision)
$$;

drop function public.chat_update_settings(uuid, text, text, text, text, integer, text, text);
-- As in 0060, plus p_proactive (OFF, SOMETIMES or OFTEN). Null keeps the current value: it comes
-- last with a default, so the API server deployed before this migration keeps working.
create function public.chat_update_settings(p_companion uuid, p_group_activity text, p_companion_interaction text,
  p_model text, p_voice text, p_revision integer, p_owner_title text default null, p_auto_memory text default null,
  p_proactive text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.chat_settings%rowtype; o uuid := companion_private.chat_owner();
begin
  s := companion_private.chat_settings_for(p_companion);
  update companion_private.chat_settings set group_activity = p_group_activity,
    companion_interaction = p_companion_interaction, model = p_model, voice = p_voice,
    owner_title = case when p_owner_title is null then owner_title else nullif(btrim(p_owner_title), '') end,
    auto_memory = coalesce(p_auto_memory, auto_memory), proactive = coalesce(p_proactive, proactive),
    revision = revision + 1
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='chat settings revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'CHAT_UPDATE_SETTINGS', 'COMPANION', s.companion_id);
  return companion_private.chat_settings_json(s);
end $$;

alter table companion_private.feature_switches drop constraint feature_switches_key_check;
alter table companion_private.feature_switches add constraint feature_switches_key_check
  check (key in ('GROUP_CHAT_CREATE', 'GROUP_CHAT_SEND', 'COMMUNITY_NEW_NOTICES', 'COMPANION_ACTIONS', 'VOICE_INPUT', 'COMPANION_REACH'));
insert into companion_private.feature_switches(key, enabled) values ('COMPANION_REACH', true);

-- As in 0060, plus companionReach: off, no Companion writes first and no reminder is set or sent.
create or replace function public.platform_features()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('groupChatCreate', companion_private.feature_on('GROUP_CHAT_CREATE'),
    'groupChatSend', companion_private.feature_on('GROUP_CHAT_SEND'),
    'voiceInput', companion_private.feature_on('VOICE_INPUT'),
    'companionReach', companion_private.feature_on('COMPANION_REACH'))
$$;

-- ---------- turns that answer nobody, and reminders ----------

alter table companion_private.chat_messages drop constraint chat_messages_reply_to_check;
alter table companion_private.chat_messages add constraint chat_messages_reply_to_check
  check (reply_to in ('OWNER', 'COMPANION', 'SELF', 'REMINDER'));

-- message_id: the reply in which the Companion set it (for the chat to show "提醒已设"); turn_id:
-- the turn that delivers it, once queued. WAITING until it is SENT, CANCELLED or MISSED.
create table companion_private.chat_reminders (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references companion_private.chats(id) on delete cascade,
  companion_id uuid not null references public.companions(id) on delete cascade,
  note text not null check (char_length(note) between 1 and 100 and note ~ '\S'),
  due_at timestamptz not null,
  status text not null default 'WAITING' check (status in ('WAITING', 'SENT', 'CANCELLED', 'MISSED')),
  message_id uuid references companion_private.chat_messages(id) on delete set null,
  turn_id uuid references companion_private.chat_messages(id) on delete set null,
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  check ((status = 'WAITING') = (done_at is null))
);
create index chat_reminders_waiting on companion_private.chat_reminders(due_at) where status = 'WAITING';
create index chat_reminders_companion on companion_private.chat_reminders(companion_id, due_at);
create index chat_reminders_message on companion_private.chat_reminders(message_id) where message_id is not null;
create index chat_reminders_turn on companion_private.chat_reminders(turn_id) where turn_id is not null;
alter table companion_private.chat_reminders enable row level security;
alter table companion_private.chat_reminders force row level security;
revoke all on companion_private.chat_reminders from public, anon, authenticated;

create function companion_private.chat_reminder_json(r companion_private.chat_reminders)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', r.id, 'dueAt', r.due_at, 'note', r.note, 'status', r.status)
$$;

-- As in 0049, plus `reminder` (the reminder this reply set, so the chat can show it) and `reach`
-- (GREETING: the Companion wrote on its own; REMINDER: it is reminding the Owner; null otherwise).
create or replace function companion_private.chat_message_json(m companion_private.chat_messages)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body, 'action', m.action,
    'mentions', to_jsonb(m.mentions), 'status', m.status, 'failure', m.failure,
    'retryable', m.status = 'FAILED' and m.failure = 'ERROR', 'sentAt', m.shown_at,
    'audio', (select jsonb_build_object('durationMs', a.duration_ms) from companion_private.chat_audio a where a.message_id = m.id),
    'reminder', (select companion_private.chat_reminder_json(r) from companion_private.chat_reminders r
      where r.message_id = m.id order by r.created_at, r.id limit 1),
    'reach', case m.reply_to when 'SELF' then 'GREETING' when 'REMINDER' then 'REMINDER' end)
$$;

-- Whether the Companion of this one-to-one chat may write on its own now (see the top).
create function companion_private.chat_greeting_due(c companion_private.chats, p_level text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare gap interval := case p_level when 'OFTEN' then interval '3 hours' else interval '8 hours' end;
  v_zone text := companion_private.chat_owner_context(c.owner_id, c.direct_companion_id)->>'timeZone';
  v_local timestamp; last_id uuid; last_at timestamptz;
begin
  if c.direct_companion_id is null or p_level is null or p_level not in ('SOMETIMES', 'OFTEN') then return false; end if;
  begin
    v_local := now() at time zone v_zone;
  exception when data_exception then -- a zone this server does not know
    v_zone := 'Asia/Shanghai';
    v_local := now() at time zone v_zone;
  end;
  if extract(hour from v_local) < 8 or extract(hour from v_local) >= 23 then return false; end if;
  select h.id, h.shown_at into last_id, last_at from companion_private.chat_messages h
    where h.chat_id = c.id and h.companion_id is null and h.status = 'SENT' order by h.shown_at desc, h.id desc limit 1;
  -- The extra wait: 0 to 99 hundredths of the gap, the same every time for the same last message.
  if last_at is null or last_at < now() - interval '7 days'
    or last_at > now() - gap - gap * (((hashtext(last_id::text) & 2147483647) % 100) / 100.0) then return false; end if;
  return not exists(select 1 from companion_private.chat_messages h where h.chat_id = c.id and h.status = 'PENDING')
    and not exists(select 1 from companion_private.chat_messages h where h.chat_id = c.id and h.reply_to = 'SELF'
      and ((h.status = 'SENT' and h.shown_at > last_at) or h.created_at > now() - gap))
    and (select count(*) from companion_private.chat_messages h where h.chat_id = c.id and h.reply_to = 'SELF'
        and h.status = 'SENT' and h.part = 1 and h.shown_at >= date_trunc('day', v_local) at time zone v_zone)
      < case p_level when 'OFTEN' then 2 else 1 end;
end $$;

-- API server only: up to p_limit Companions with a reminder to deliver or a message of their own
-- to write now, with the Owner's auth subject to write as; reminders first. [{companionId, subject}]
-- p_platform false (the server has no platform model): for writing on their own, only Companions
-- on the Owner's own key or agent. A reminder needs no model (the server has plain words for it).
-- A reminder whose turn was queued but never written (the server stopped in between) is due again
-- once nobody is writing it, so it does not wait for the Owner to open the chat.
create function public.chat_reach_due(p_limit integer, p_platform boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('companionId', d.companion_id, 'subject', d.subject) order by d.turn_kind, d.since), '[]')
  from (
    select x.companion_id, x.subject, min(x.turn_kind) as turn_kind, min(x.since) as since from (
      select r.companion_id, o.auth_user_id as subject, 0 as turn_kind, r.due_at as since
      from companion_private.chat_reminders r
      join public.companions c on c.id = r.companion_id and c.status = 'ACTIVE'
      join public.owners o on o.id = c.owner_id and o.status = 'ACTIVE'
      where r.status = 'WAITING' and r.due_at <= now()
        and (r.turn_id is null or exists(select 1 from companion_private.chat_messages t where t.id = r.turn_id
          and t.status = 'PENDING' and coalesce(t.claimed_at, '-infinity') < now() - interval '2 minutes'))
      union all
      select s.companion_id, o.auth_user_id, 1, ch.active_at
      from companion_private.chat_settings s
      join public.companions c on c.id = s.companion_id and c.status = 'ACTIVE'
      join public.owners o on o.id = c.owner_id and o.status = 'ACTIVE'
      join companion_private.chats ch on ch.direct_companion_id = s.companion_id
      where s.proactive <> 'OFF'
        and (p_platform or exists(select 1 from companion_private.companion_connections k where k.companion_id = s.companion_id))
        and companion_private.chat_greeting_due(ch, s.proactive)
    ) x
    where companion_private.feature_on('COMPANION_REACH')
    group by x.companion_id, x.subject
    order by min(x.turn_kind), min(x.since)
    limit greatest(0, least(p_limit, 100))) d
$$;

-- API server only, as the Owner: queues the turn if one is still due. Returns {"status": ...}:
--   OFF      the operators' switch is off
--   BUSY     a reminder is due but the chat is waiting for another reply: next round
--   NOT_DUE  nothing to do (any more)
--   QUEUED   with chatId and kind (REMINDER or GREETING): write the chat's queued turns now
--            (also when a reminder's turn was queued earlier and is still waiting to be written)
create function public.chat_reach_begin(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); s companion_private.chat_settings%rowtype;
  c companion_private.chats%rowtype; r companion_private.chat_reminders%rowtype; v_turn uuid;
begin
  s := companion_private.chat_settings_for(p_companion); -- "companion not found" unless it is the Owner's
  if not companion_private.feature_on('COMPANION_REACH') then return jsonb_build_object('status', 'OFF'); end if;
  -- Lock the chat first, like every other writer.
  select * into c from companion_private.chats where owner_id = o and direct_companion_id = p_companion for update;
  if not found then return jsonb_build_object('status', 'NOT_DUE'); end if;
  update companion_private.chat_reminders set status = 'MISSED', done_at = now()
    where companion_id = p_companion and status = 'WAITING' and turn_id is null
      and (due_at < now() - interval '24 hours' or attempts >= 5);
  if exists(select 1 from companion_private.chat_reminders w join companion_private.chat_messages t on t.id = w.turn_id
      where w.companion_id = p_companion and w.status = 'WAITING' and t.status = 'PENDING') then
    return jsonb_build_object('status', 'QUEUED', 'chatId', c.id, 'kind', 'REMINDER');
  end if;
  select * into r from companion_private.chat_reminders
    where companion_id = p_companion and status = 'WAITING' and turn_id is null and due_at <= now()
    order by due_at, id limit 1;
  if found then
    if exists(select 1 from companion_private.chat_messages where chat_id = c.id and status = 'PENDING') then
      return jsonb_build_object('status', 'BUSY');
    end if;
    insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
      values (c.id, p_companion, 'PENDING', 'REMINDER', true) returning id into v_turn;
    update companion_private.chat_reminders set turn_id = v_turn, attempts = attempts + 1 where id = r.id;
    return jsonb_build_object('status', 'QUEUED', 'chatId', c.id, 'kind', 'REMINDER');
  end if;
  if not companion_private.chat_greeting_due(c, s.proactive) then return jsonb_build_object('status', 'NOT_DUE'); end if;
  insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
    values (c.id, p_companion, 'PENDING', 'SELF', true);
  return jsonb_build_object('status', 'QUEUED', 'chatId', c.id, 'kind', 'GREETING');
end $$;

-- The Owner's view: the reminders a Companion still has to deliver, soonest first ({ items }).
create function public.chat_reminder_list(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return jsonb_build_object('items', coalesce((select jsonb_agg(companion_private.chat_reminder_json(r) order by r.due_at, r.id)
    from companion_private.chat_reminders r where r.companion_id = c and r.status = 'WAITING'), '[]'));
end $$;

-- The Owner cancels one that has not been delivered.
create function public.chat_reminder_cancel(p_companion uuid, p_reminder uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  update companion_private.chat_reminders set status = 'CANCELLED', done_at = now()
    where id = p_reminder and companion_id = c and status = 'WAITING';
  if not found then raise exception using errcode='P0001', message='reminder not found'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'CHAT_REMINDER_CANCEL', 'COMPANION', c);
  return jsonb_build_object('deleted', true);
end $$;

-- ---------- writing those turns ----------

-- As in 0060, plus what a turn that answers nobody needs:
--   reach      {kind: GREETING} or {kind: REMINDER, note, dueAt}; null for an ordinary turn
--   canRemind  in this reply it may set and cancel reminders (one-to-one chats, switch on)
--   reminders  the reminders it still has to deliver, soonest first: [{id, dueAt, note}]
-- A queued turn of its own initiative is dropped when the Owner wrote meanwhile (it will answer
-- that instead), and a reminder turn when its reminder is no longer waiting (cancelled meanwhile).
-- A reminder turn that used up its tries gives the reminder back, to be queued again.
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
      and not (m.reply_to = 'SELF' and exists(select 1 from companion_private.chat_messages h
        where h.chat_id = c.id and h.companion_id is null and h.status = 'SENT' and h.created_at > m.created_at))
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
  reach := c.direct_companion_id is not null and companion_private.feature_on('COMPANION_REACH');
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
    'canAct', c.direct_companion_id is not null and companion_private.feature_on('COMPANION_ACTIONS'),
    'reach', case m.reply_to when 'SELF' then jsonb_build_object('kind', 'GREETING')
      when 'REMINDER' then jsonb_build_object('kind', 'REMINDER', 'note', r.note, 'dueAt', r.due_at) end,
    'canRemind', reach,
    'reminders', case when reach then coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'dueAt', q.due_at, 'note', q.note)
        order by q.due_at, q.id)
      from (select * from companion_private.chat_reminders w where w.companion_id = m.companion_id and w.status = 'WAITING'
        and w.turn_id is null order by w.due_at, w.id limit 20) q), '[]') else '[]'::jsonb end)
    || companion_private.chat_owner_context(c.owner_id, m.companion_id);
end $$;

-- As in 0051, with one change: a turn that answers nobody is background work, so the Owner's wallet
-- keeps what it needs for answering the Owner (wallet_check's floor).
create or replace function public.chat_reserve(p_reply uuid, p_claim uuid, p_purpose text, p_provider text, p_model text,
  p_pricing_version text, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_trace text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid; result jsonb;
begin
  if p_purpose is null or p_purpose not in ('REPLY', 'DECIDE') then
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
    p_trace, m.attempts, encode(sha256(convert_to(m.claim_id::text || ':' || p_purpose,'UTF8')), 'hex'));
  if result->>'decision' = 'RESERVED' then
    update companion_private.chat_messages set compute_tx = (result->>'transactionId')::uuid where id = m.id;
  end if;
  return result;
end $$;

drop function public.chat_finish(uuid, uuid, text, text[], jsonb, text);
-- As in 0060, plus p_reminders for SENT in a one-to-one chat (ignored elsewhere, and while the
-- switch is off): {"set": {"at": "2026-11-27 08:00", "note": "…"}, "cancel": [reminder ids]}.
-- `at` is the Owner's local time; a time that cannot be read, is not between half a minute and a
-- year from now, or would be the 21st waiting reminder sets nothing, and neither does one the
-- Companion already has for that minute. (It comes last with a default, so the API server
-- deployed before this migration keeps working.)
-- A REMINDER turn that is SENT has delivered its reminder; one that ends any other way gives it
-- back to be queued again.
create function public.chat_finish(p_reply uuid, p_claim uuid, p_outcome text, p_bodies text[], p_audio jsonb default null,
  p_action text default null, p_reminders jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid;
  v_bodies text[] := array(select btrim(b) from unnest(p_bodies) b); n integer := coalesce(cardinality(p_bodies), 0);
  pause interval := companion_private.chat_seconds(0.6); start_at timestamptz; done_at timestamptz; i integer;
  failed boolean := p_outcome in ('ERROR', 'UNAVAILABLE', 'DISABLED', 'QUOTA');
  clip jsonb; v_id uuid; keep integer; acted integer := (p_action is not null)::integer;
  v_due timestamptz; v_note text;
begin
  if p_outcome is null or p_outcome not in ('SENT', 'PASSED', 'BLOCKED', 'ERROR', 'UNAVAILABLE', 'DISABLED', 'QUOTA')
    or (p_outcome = 'SENT') <> (p_bodies is not null)
    or (p_action is not null and (p_outcome <> 'SENT' or p_action not in ('WAVE', 'PAT_HEAD', 'HUG', 'CUDDLE')))
    or (p_outcome = 'SENT' and (n < 1 - acted or n > 3 or exists(select 1 from unnest(v_bodies) b
      where b is null or b !~ '\S' or char_length(b) > 2000)))
    or (p_audio is not null and (p_outcome <> 'SENT' or jsonb_typeof(p_audio) <> 'array' or jsonb_array_length(p_audio) <> n
      or exists(select 1 from jsonb_array_elements(p_audio) e where jsonb_typeof(e) not in ('null', 'object'))))
    or (p_reminders is not null and (jsonb_typeof(p_reminders) <> 'object'
      or jsonb_typeof(coalesce(p_reminders->'cancel', '[]')) <> 'array'
      or jsonb_typeof(coalesce(p_reminders->'set', '{}')) <> 'object')) then
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
    update companion_private.chat_reminders set status = 'SENT', done_at = now() where turn_id = m.id and status = 'WAITING';
    if p_reminders is not null and c.direct_companion_id is not null and companion_private.feature_on('COMPANION_REACH') then
      -- A text that is not a time, an id that is not one: that part is skipped, the reply is kept.
      begin
        update companion_private.chat_reminders set status = 'CANCELLED', done_at = now()
          where companion_id = m.companion_id and status = 'WAITING' and turn_id is null
            and id in (select x::uuid from jsonb_array_elements_text(coalesce(p_reminders->'cancel', '[]')) x);
      exception when data_exception then null;
      end;
      begin
        v_note := btrim(p_reminders->'set'->>'note');
        v_due := (p_reminders->'set'->>'at')::timestamp
          at time zone (companion_private.chat_owner_context(c.owner_id, m.companion_id)->>'timeZone');
        if v_due > now() + interval '30 seconds' and v_due < now() + interval '366 days'
          and v_note ~ '\S' and char_length(v_note) <= 100
          and (select count(*) from companion_private.chat_reminders where companion_id = m.companion_id and status = 'WAITING') < 20
          and not exists(select 1 from companion_private.chat_reminders where companion_id = m.companion_id and status = 'WAITING'
            and date_trunc('minute', due_at) = date_trunc('minute', v_due)) then
          insert into companion_private.chat_reminders(chat_id, companion_id, note, due_at, message_id)
            values (c.id, m.companion_id, v_note, v_due, m.id);
        end if;
      exception when data_exception then null;
      end;
    end if;
  else
    update companion_private.chat_messages set
      status = case when failed then 'FAILED' else p_outcome end,
      failure = case when failed then p_outcome end,
      typing_at = null, shown_at = greatest(now(), coalesce(done_at, now())), claim_id = null, compute_tx = null
    where id = m.id;
    update companion_private.chat_reminders set turn_id = null where turn_id = m.id and status = 'WAITING';
  end if;
  if p_outcome <> 'PASSED' then update companion_private.chats set active_at = now() where id = c.id returning * into c; end if;
  if not exists(select 1 from companion_private.chat_messages where chat_id = c.id and status = 'PENDING') then
    perform companion_private.chat_queue_followup(c);
  end if;
  return jsonb_build_object('accepted', true);
end $$;

revoke all on function companion_private.chat_reminder_json(companion_private.chat_reminders),
  companion_private.chat_greeting_due(companion_private.chats, text),
  public.chat_reach_due(integer, boolean), public.chat_reach_begin(uuid),
  public.chat_reminder_list(uuid), public.chat_reminder_cancel(uuid, uuid),
  public.chat_update_settings(uuid, text, text, text, text, integer, text, text, text),
  public.chat_finish(uuid, uuid, text, text[], jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.chat_update_settings(uuid, text, text, text, text, integer, text, text, text),
  public.chat_reminder_list(uuid), public.chat_reminder_cancel(uuid, uuid) to authenticated;
-- Queueing and writing a Companion's turns is the server's job: not reachable through Supabase's own REST API.
grant execute on function public.chat_reach_due(integer, boolean), public.chat_reach_begin(uuid),
  public.chat_finish(uuid, uuid, text, text[], jsonb, text, jsonb) to companion_api;

insert into companion_private.schema_migrations(name) values ('202611270070_companion_reach');

commit;
