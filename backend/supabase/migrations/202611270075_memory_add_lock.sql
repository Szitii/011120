begin;

-- Adding a memory by hand takes the Companion's lock the way every other writer into a Companion
-- does since 0069 (companion_private.locked_companion): it waits for a deletion that is under way
-- and then finds the Companion gone. Until now it only waited, and then wrote a memory into the
-- deleted Companion that nothing would ever list or remove.
--
-- As in 0047, with that one change.
create or replace function public.memory_add(p_companion uuid, p_body text, p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.locked_companion(p_companion); -- first, so two requests cannot both count 199
  m companion_private.companion_memories%rowtype; v_body text := btrim(p_body); o uuid := companion_private.chat_owner();
begin
  if v_body is null or v_body !~ '\S' or char_length(v_body) > 500 or p_key is null or p_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023', message='invalid memory';
  end if;
  select * into m from companion_private.companion_memories where companion_id = c and key_hash = p_key;
  if found then
    if m.body <> v_body then raise exception using errcode='23505', message='idempotency conflict'; end if;
    return companion_private.memory_json(m);
  end if;
  if (select count(*) from companion_private.companion_memories where companion_id = c) >= 200 then
    raise exception using errcode='55000', message='memory limit reached';
  end if;
  insert into companion_private.companion_memories(companion_id, body, source, key_hash) values (c, v_body, 'OWNER', p_key) returning * into m;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'MEMORY_ADD', 'MEMORY', m.id);
  return companion_private.memory_json(m);
end $$;

insert into companion_private.schema_migrations(name) values ('202611270075_memory_add_lock');

commit;
