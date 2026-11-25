begin;

-- 自动记忆 is on unless the Owner turns it off, and the default pace is slower.
--
--   OFF        the Owner turned it off
--   SOMETIMES  (the default now) after every 50 messages of the Owner in the one-to-one chat; was 30
--   OFTEN      after every 10, as before
--
-- A Companion that never had it on starts with everything said so far, once (the newest 130
-- messages), like any Companion whose Owner switches it on.

alter table companion_private.chat_settings alter column auto_memory set default 'SOMETIMES';

-- Every OFF so far is the old default, not a choice: the setting went live on 2026-11-25 and no
-- build of the app shows it yet.
update companion_private.chat_settings set auto_memory = 'SOMETIMES' where auto_memory = 'OFF';

-- As in 0060, with 50 in place of 30.
create or replace function public.memory_auto_begin(p_companion uuid)
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
  need := case s.auto_memory when 'OFTEN' then 10 else 50 end;
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

commit;
