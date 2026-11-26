begin;

-- A Companion may search the web while it answers its Owner (家机联网).
--
-- The searching is not ours: DeepSeek's chat API has a tool for it that the model calls by itself
-- and DeepSeek runs (the search is not billed; what the model reads of it is billed as input
-- tokens, so such a reply costs more). The API server declares that tool on a reply when
--   * the operators' switch COMPANION_WEB is on (off until the cost has been looked at),
--   * the turn answers the Owner (not a turn of its own, a diary entry, a post or memory notes),
--   * the model that writes the reply has the tool (the catalog says which: today DeepSeek Flash).
-- Companions on the Owner's own key or agent are not touched.
--
-- The switch reaches the API server with the turn: chat_claim says `canBrowse`.

alter table companion_private.feature_switches drop constraint feature_switches_key_check;
alter table companion_private.feature_switches add constraint feature_switches_key_check
  check (key in ('GROUP_CHAT_CREATE', 'GROUP_CHAT_SEND', 'COMMUNITY_NEW_NOTICES', 'COMPANION_ACTIONS', 'VOICE_INPUT', 'COMPANION_REACH',
    'COMPANION_WEB'));
insert into companion_private.feature_switches(key, enabled) values ('COMPANION_WEB', false);

-- As in 0070, plus canBrowse: the operators let Companions search the web.
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
    'canBrowse', companion_private.feature_on('COMPANION_WEB'),
    'reminders', case when reach then coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'dueAt', q.due_at, 'note', q.note)
        order by q.due_at, q.id)
      from (select * from companion_private.chat_reminders w where w.companion_id = m.companion_id and w.status = 'WAITING'
        and w.turn_id is null order by w.due_at, w.id limit 20) q), '[]') else '[]'::jsonb end)
    || companion_private.chat_owner_context(c.owner_id, m.companion_id);
end $$;

insert into companion_private.schema_migrations(name) values ('202611270071_companion_web');

commit;
