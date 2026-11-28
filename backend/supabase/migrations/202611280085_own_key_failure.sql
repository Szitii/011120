begin;

-- A reply that failed because the Owner's own key or agent gave no usable answer says so (自带 Key
-- 失败时讲清原因).
--
-- Until now such a reply looked like any other failure ("something went wrong, try again"), and
-- the Owner tried again and again while the cause was on their side: a key that was revoked, an
-- account without money, a model name that no longer exists. The API server knows the cause when
-- the call fails; it now notes it on the failed reply, and the app shows it.
--
-- The note is one word (see ConnectionFailure in contracts/chat.ts), never the provider's own text.
-- It belongs to one failed attempt: a retry clears it.

alter table companion_private.chat_messages
  add column failure_detail text check (failure_detail in
    ('AUTH_FAILED', 'NO_BALANCE', 'RATE_LIMITED', 'NOT_FOUND', 'UNREACHABLE', 'BAD_ANSWER', 'BLOCKED_ADDRESS', 'ERROR'));

-- Server only: notes on a reply of the signed-in Owner's that has just failed (failure ERROR) why
-- their own key or agent gave no usable answer. {"noted": false} when there is no such reply.
create function public.chat_fail_note(p_reply uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  if p_reason is null or p_reason not in
    ('AUTH_FAILED', 'NO_BALANCE', 'RATE_LIMITED', 'NOT_FOUND', 'UNREACHABLE', 'BAD_ANSWER', 'BLOCKED_ADDRESS', 'ERROR') then
    raise exception using errcode='22023', message='invalid reason';
  end if;
  update companion_private.chat_messages m set failure_detail = p_reason
    from companion_private.chats c
    where m.id = p_reply and c.id = m.chat_id and c.owner_id = o and m.status = 'FAILED' and m.failure = 'ERROR';
  return jsonb_build_object('noted', found);
end $$;

-- As in 0070, plus connectionFailure: the note above, while the reply is a failed one.
create or replace function companion_private.chat_message_json(m companion_private.chat_messages)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body, 'action', m.action,
    'mentions', to_jsonb(m.mentions), 'status', m.status, 'failure', m.failure,
    'connectionFailure', case when m.status = 'FAILED' and m.failure = 'ERROR' then m.failure_detail end,
    'retryable', m.status = 'FAILED' and m.failure = 'ERROR', 'sentAt', m.shown_at,
    'audio', (select jsonb_build_object('durationMs', a.duration_ms) from companion_private.chat_audio a where a.message_id = m.id),
    'reminder', (select companion_private.chat_reminder_json(r) from companion_private.chat_reminders r
      where r.message_id = m.id order by r.created_at, r.id limit 1),
    'reach', case m.reply_to when 'SELF' then 'GREETING' when 'REMINDER' then 'REMINDER' end)
$$;

-- As in 0040; the note of the attempt that failed goes with it.
create or replace function public.chat_retry(p_chat uuid, p_message uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype;
begin
  c := companion_private.chat_for(p_chat);
  select * into m from companion_private.chat_messages where id = p_message and chat_id = c.id and companion_id is not null;
  if not found then raise exception using errcode='P0001', message='message not found'; end if;
  if m.status <> 'FAILED' or m.failure <> 'ERROR' then raise exception using errcode='55000', message='message cannot be retried'; end if;
  -- Asked again by the Owner, so it must answer now.
  update companion_private.chat_messages set status = 'PENDING', failure = null, failure_detail = null, shown_at = null, optional = false,
    typing_at = now() + companion_private.chat_seconds(1), claim_id = null, claimed_at = null, attempts = 0 where id = m.id;
  return companion_private.chat_progress(c);
end $$;

revoke all on function public.chat_fail_note(uuid, text) from public, anon, authenticated;
grant execute on function public.chat_fail_note(uuid, text) to companion_api;

insert into companion_private.schema_migrations(name) values ('202611280085_own_key_failure');

commit;
