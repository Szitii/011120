begin;

-- Part 1: which migrations this database has.
--
-- Until now nothing recorded it: the deploy script guessed from what each migration leaves behind
-- (a table, a column, a function's signature), and a guess that named a function broke when a later
-- migration changed that function. From this one on, every migration ends by writing its own file
-- name here, and the deploy script asks this table.

create table companion_private.schema_migrations (
  name text primary key check (name ~ '^[0-9]{12}_[a-z0-9_]+$'),
  applied_at timestamptz not null default now()
);
alter table companion_private.schema_migrations enable row level security;
alter table companion_private.schema_migrations force row level security;
revoke all on companion_private.schema_migrations from public, anon, authenticated;

-- Part 2: a Companion's own notes can take the place of older ones.
--
-- 自动记忆 only ever added. When the Owner changed jobs, the Companion ended up remembering both
-- the old job and the new one. Now the model taking notes sees what the Companion already
-- remembers with each memory's id (`known`, every memory, so the API server can show it the ones
-- that have to do with the chat, not just the newest), and may hand in a sentence in place of a
-- memory the Companion noted down itself (source AUTO). What the Owner wrote or approved from an
-- imported card is never replaced.

-- As in 0065, plus `known`: every memory as {id, body, source, createdAt}, newest first (at most
-- 200). `memories` (the newest 60, as text) stays for the API server deployed before this migration.
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
        order by m.created_at desc, m.id desc limit 60) q), '[]'),
    'known', coalesce((select jsonb_agg(companion_private.memory_json(m) order by m.created_at desc, m.id desc)
      from companion_private.companion_memories m where m.companion_id = p_companion), '[]'));
end $$;

drop function public.memory_auto_finish(uuid, uuid, text[]);
-- Ends an attempt. p_bodies: the sentences to remember (0 to 2, each 1 to 500 characters), or null
-- when the attempt failed. p_replaces: for each sentence, the id of the memory it takes the place
-- of, or null for a new one; it comes last with a default, so the API server deployed before this
-- migration keeps working and replaces nothing.
--
-- A replaced memory is deleted and the sentence stored in its place, if it is this Companion's and
-- one it noted down itself (AUTO); any other id is ignored and the sentence is kept as a new
-- memory. A sentence it already remembers word for word is not stored again. At 200 memories the
-- oldest AUTO one from an earlier attempt makes room; when there is none to remove, nothing more
-- is added.
-- Returns {"accepted", "added", "replaced"}; accepted false when the attempt was already given up.
create function public.memory_auto_finish(p_companion uuid, p_claim uuid, p_bodies text[], p_replaces uuid[] default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a companion_private.memory_notes%rowtype; v_body text; i integer; took boolean;
  added integer := 0; replaced integer := 0;
begin
  if cardinality(p_bodies) > 2 or exists(select 1 from unnest(p_bodies) b
      where b is null or b !~ '\S' or char_length(btrim(b)) > 500)
    or (p_replaces is not null and cardinality(p_replaces) <> cardinality(p_bodies)) then
    raise exception using errcode='22023', message='invalid memories';
  end if;
  -- The Companion before its notes, the order memory_add takes them in (it counts under this lock).
  perform 1 from public.companions where id = companion_private.owned_companion(p_companion) for no key update;
  a := companion_private.memory_notes_for(p_companion);
  if a.claim_id is null or a.claim_id is distinct from p_claim then
    return jsonb_build_object('accepted', false, 'added', 0, 'replaced', 0);
  end if;
  perform companion_private.chat_abandon_compute(companion_private.chat_owner(), a.compute_tx);
  if p_bodies is null then
    update companion_private.memory_notes set claim_id = null, claimed_at = null, compute_tx = null, pending_until = null,
      failed_at = now() where companion_id = p_companion;
    return jsonb_build_object('accepted', true, 'added', 0, 'replaced', 0);
  end if;
  for i in 1 .. cardinality(p_bodies) loop
    v_body := btrim(p_bodies[i]);
    took := false;
    if p_replaces[i] is not null then
      delete from companion_private.companion_memories
        where id = p_replaces[i] and companion_id = p_companion and source = 'AUTO';
      took := found;
    end if;
    if exists(select 1 from companion_private.companion_memories where companion_id = p_companion and body = v_body) then
      -- It already says so elsewhere: the outdated memory is gone, and that is all.
      if took then replaced := replaced + 1; end if;
      continue;
    end if;
    if (select count(*) from companion_private.companion_memories where companion_id = p_companion) >= 200 then
      delete from companion_private.companion_memories where id = (select id from companion_private.companion_memories
        where companion_id = p_companion and source = 'AUTO' and created_at < now() order by created_at, id limit 1);
      exit when not found;
    end if;
    insert into companion_private.companion_memories(companion_id, body, source) values (p_companion, v_body, 'AUTO');
    if took then replaced := replaced + 1; else added := added + 1; end if;
  end loop;
  update companion_private.memory_notes set covers_until = pending_until, pending_until = null, claim_id = null, claimed_at = null,
    compute_tx = null, failed_at = null where companion_id = p_companion;
  return jsonb_build_object('accepted', true, 'added', added, 'replaced', replaced);
end $$;

revoke all on function public.memory_auto_finish(uuid, uuid, text[], uuid[]) from public, anon, authenticated;
-- Writing a Companion's memories is the server's job: not reachable through Supabase's own REST API.
grant execute on function public.memory_auto_finish(uuid, uuid, text[], uuid[]) to companion_api;

insert into companion_private.schema_migrations(name) values ('202611270069_memory_replace');

commit;
