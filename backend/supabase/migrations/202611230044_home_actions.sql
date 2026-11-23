begin;

-- Home-room actions (小家): the Owner waves at, pats, hugs or cuddles one of their Companions.
--
-- The app plays the animation at once; this only records it, so the Companion knows:
--   * Each action is one Owner row in the one-to-one chat with that Companion (action set, no
--     body). The chat page shows it as a grey line, and the Companion sees it among the last 30
--     messages it reads before every reply. That is all the "memory" there is for now.
--   * The first action of a burst queues one optional turn: the Companion may answer with a line
--     or stay quiet (the model decides). An action less than 3 minutes after the previous one,
--     or while a reply is already on the way, queues nothing, so tapping again and again costs
--     at most one model turn. Actions count toward the Owner's 300 messages per hour.

alter table companion_private.chat_messages add column action text
  check (action in ('WAVE', 'PAT_HEAD', 'HUG', 'CUDDLE'));
-- Was (status = 'SENT') = (body is not null); an action row is SENT with no body.
alter table companion_private.chat_messages drop constraint chat_messages_check3;
alter table companion_private.chat_messages add constraint chat_messages_sent_check
  check ((status = 'SENT') = (body is not null or action is not null));
alter table companion_private.chat_messages add constraint chat_messages_action_owner_check
  check (action is null or (companion_id is null and body is null));
create index chat_messages_actions on companion_private.chat_messages(chat_id, created_at) where action is not null;

create or replace function companion_private.chat_message_json(m companion_private.chat_messages)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body, 'action', m.action,
    'mentions', to_jsonb(m.mentions), 'status', m.status, 'failure', m.failure,
    'retryable', m.status = 'FAILED' and m.failure = 'ERROR', 'sentAt', m.shown_at)
$$;

-- The Owner does an action to their Companion; returns the chat id, the action row, typing and
-- replying. A retry with the same key returns the first row; the same key with another action
-- (or used for a text message) is a conflict.
create function public.chat_act(p_companion uuid, p_action text, p_key text)
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
      and created_at > now() - interval '3 minutes') then
    insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional)
      values (c.id, p_companion, 'PENDING', 'OWNER', true);
  end if;
  -- Added after the check above, so the 3-minute rule only looks at earlier actions.
  insert into companion_private.chat_messages(chat_id, action, status, key_hash, shown_at)
    values (c.id, p_action, 'SENT', p_key, now()) returning * into m;
  update companion_private.chats set active_at = now() where id = c.id returning * into c;
  return jsonb_build_object('chatId', c.id, 'message', companion_private.chat_message_json(m)) || companion_private.chat_progress(c);
end $$;

-- Same as in 0041, plus each history entry carries its action.
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
        'mentions', to_jsonb(q.mentions), 'sentAt', q.shown_at) order by q.shown_at, q.id)
      from (select * from companion_private.chat_messages h where h.chat_id = c.id and h.status = 'SENT'
        order by h.shown_at desc, h.id desc limit 30) q), '[]'));
end $$;

-- Same as in 0042, plus each message carries its action.
create or replace function companion_admin.chat_read(p_chat uuid, p_reason text, p_before_at timestamptz default null,
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
    select m.created_at, m.id, jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body, 'action', m.action,
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

revoke all on function public.chat_act(uuid, text, text) from public, anon, authenticated;
grant execute on function public.chat_act(uuid, text, text) to authenticated;

commit;
