begin;

-- Three more ways for an Owner to shape how a Companion talks, all per Companion:
--
--   1. 示例对话 (dialogueExamples): a few lines that show how it speaks. One more persona field,
--      up to 1500 characters, rewritten by the Owner like the others (persona_save) and offered
--      from an imported card's `mes_example`, which used to be thrown away. Nothing new is stored
--      for it: it lives in the identity document.
--   2. 世界书 (world_entries): pieces of background ("小白：主人养的猫，三岁，怕打雷"), each with
--      1 to 8 trigger words. An entry is told to the model only while one of its words is in the
--      recent conversation, so a large setting does not ride along with every reply. Written by
--      the Owner, or approved one by one from an imported card's `character_book`. At most 100.
--   3. 正则替换 (chat_settings.reply_rules): up to 10 "find this pattern, put that in its place"
--      rules the API server runs over each message of a reply before the safety scan. The API
--      server checks that each pattern compiles and runs every rule under a time limit; the
--      database keeps the list.
--
-- World entries and persona texts are scanned by the API server before they are saved (keys,
-- private data, injected instructions, links), like an import, so their save functions are the
-- server's alone.

-- ---------- 2. world book ----------

create table companion_private.world_entries (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references public.companions(id) on delete cascade,
  keys text[] not null check (cardinality(keys) between 1 and 8),
  body text not null check (char_length(body) between 1 and 1000 and body ~ '\S'),
  enabled boolean not null default true,
  source text not null check (source in ('IMPORT', 'OWNER')),
  import_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source = 'IMPORT') = (import_id is not null))
);
create index world_entries_list on companion_private.world_entries(companion_id, created_at, id);
alter table companion_private.world_entries enable row level security;
alter table companion_private.world_entries force row level security;
revoke all on companion_private.world_entries from public, anon, authenticated;

create function companion_private.world_json(w companion_private.world_entries)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', w.id, 'keys', to_jsonb(w.keys), 'body', w.body, 'enabled', w.enabled, 'source', w.source,
    'createdAt', w.created_at, 'updatedAt', w.updated_at)
$$;

-- Every entry of the Companion, in the order they were written (at most 100).
create function public.world_list(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return jsonb_build_object('items', coalesce((select jsonb_agg(companion_private.world_json(w) order by w.created_at, w.id)
    from companion_private.world_entries w where w.companion_id = c), '[]'));
end $$;

-- Server only (the texts are scanned first). p_entry null: a new entry; else that entry is rewritten.
-- Trigger words are trimmed and repeated ones dropped (whatever their case). The same words with the
-- same text as an entry the Companion already has returns that entry, so a retried request adds nothing.
create function public.world_save(p_companion uuid, p_entry uuid, p_keys text[], p_body text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
  w companion_private.world_entries%rowtype; v_body text := btrim(p_body, E' \t\r\n');
  -- Trimmed, in the order given, without a word that came before in another case.
  v_keys text[] := array(select btrim(x) from unnest(p_keys) with ordinality t(x, i)
    where x is not null and not exists(select 1 from unnest(p_keys) with ordinality e(y, j)
      where j < i and lower(btrim(y)) = lower(btrim(x))) order by i);
begin
  if v_body is null or v_body !~ '\S' or char_length(v_body) > 1000 or p_enabled is null
    or cardinality(v_keys) < 1 or cardinality(v_keys) > 8
    or exists(select 1 from unnest(v_keys) k where k = '' or char_length(k) > 40 or k ~ '[[:cntrl:]]') then
    raise exception using errcode='22023', message='invalid world entry';
  end if;
  -- The Companion first, so two requests cannot both count 99.
  -- Waits for a deletion that is under way, and then finds the Companion gone instead of writing into it.
  perform 1 from public.companions where id = c and status <> 'DELETED' for no key update;
  if not found then raise exception using errcode='P0001', message='companion not found'; end if;
  if p_entry is null then
    select * into w from companion_private.world_entries where companion_id = c and body = v_body and keys = v_keys limit 1;
    if found then return companion_private.world_json(w); end if;
    if (select count(*) from companion_private.world_entries where companion_id = c) >= 100 then
      raise exception using errcode='55000', message='world entry limit reached';
    end if;
    insert into companion_private.world_entries(companion_id, keys, body, enabled, source)
      values (c, v_keys, v_body, p_enabled, 'OWNER') returning * into w;
  else
    update companion_private.world_entries set keys = v_keys, body = v_body, enabled = p_enabled, updated_at = now()
      where id = p_entry and companion_id = c returning * into w;
    if not found then raise exception using errcode='P0001', message='world entry not found'; end if;
  end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'WORLD_ENTRY_SAVE', 'WORLD_ENTRY', w.id);
  return companion_private.world_json(w);
end $$;

create function public.world_delete(p_companion uuid, p_entry uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  delete from companion_private.world_entries where id = p_entry and companion_id = c;
  if not found then raise exception using errcode='P0001', message='world entry not found'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'WORLD_ENTRY_DELETE', 'WORLD_ENTRY', p_entry);
  return jsonb_build_object('deleted', true);
end $$;

-- Same as in 0047, plus: approved `worldEntry` candidates ({keys, body}) become the Companion's world
-- book entries (at most 100 per Companion), the way approved `memory` candidates become memories.
create or replace function public.approve_companion_import(
  p_import_id uuid,
  p_approved_candidate_ids text[],
  p_companion_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text
) returns table(payload jsonb)
language plpgsql security definer set search_path='' as $$
declare
  actor public.owners%rowtype;
  import_row companion_private.companion_imports%rowtype;
  existing companion_private.approval_idempotency%rowtype;
  companion_row public.companions%rowtype;
  current_identity public.companion_identities%rowtype;
  identity_row public.companion_identities%rowtype;
  candidate jsonb;
  identity_doc jsonb:='{}'::jsonb;
  source_manifest jsonb;
  display_name text;
  next_version integer;
  new_companion_id uuid;
  new_identity_id uuid:=gen_random_uuid();
  content_hash text;
  approved_at timestamptz:=statement_timestamp();
  memories text[]:='{}';
  world jsonb:='[]'::jsonb;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_idempotency_key_hash!~'^[a-f0-9]{64}$' or p_request_hash!~'^[a-f0-9]{64}$'
    or p_approved_candidate_ids is null or cardinality(p_approved_candidate_ids)<1
    or (select count(*) from unnest(p_approved_candidate_ids) x)<>(select count(distinct x) from unnest(p_approved_candidate_ids) x) then
    raise exception using errcode='22023',message='invalid Companion import approval';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.approval_idempotency where owner_id=actor.id and idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.request_hash<>p_request_hash then raise exception using errcode='23505',message='Companion approval idempotency key reused with a different request'; end if;
    select * into identity_row from public.companion_identities where id=existing.identity_id and owner_id=actor.id;
    return query select companion_private.identity_payload(identity_row); return;
  end if;

  select * into import_row from companion_private.companion_imports where id=p_import_id and owner_id=actor.id for update;
  if not found then raise exception using errcode='P0001',message='Companion import not found'; end if;
  if import_row.status<>'REVIEWABLE' or import_row.normalized_draft is null then
    raise exception using errcode='55000',message='only a reviewable Companion import may be approved';
  end if;

  foreach candidate in array array(select value from jsonb_array_elements(import_row.normalized_draft->'candidates')) loop
    if (candidate->>'id')=any(p_approved_candidate_ids) then
      if coalesce((candidate->>'approvable')::boolean,false) is not true then
        raise exception using errcode='22023',message='blocked identity candidate cannot be approved';
      end if;
      if candidate->>'field'='memory' then
        memories:=memories||(candidate->>'value');
      elsif candidate->>'field'='worldEntry' then
        world:=world||jsonb_build_array(candidate->'value');
      else
        identity_doc:=identity_doc||jsonb_build_object(candidate->>'field',candidate->'value');
      end if;
      if candidate->>'field'='displayName' then display_name:=candidate->>'value'; end if;
    end if;
  end loop;

  if display_name is null or btrim(display_name)='' then
    raise exception using errcode='22023',message='display name candidate must be explicitly approved';
  end if;
  if exists(
    select 1 from unnest(p_approved_candidate_ids) requested
    where not exists(select 1 from jsonb_array_elements(import_row.normalized_draft->'candidates') c where c->>'id'=requested)
  ) then raise exception using errcode='22023',message='approval references an unknown candidate'; end if;

  if p_companion_id is null then
    new_companion_id:=gen_random_uuid();
    insert into public.companions(id,owner_id,status,origin_type,private_runtime_enabled)
    values(new_companion_id,actor.id,'ACTIVE','IMPORTED_CARD',false)
    returning * into companion_row;
  else
    select * into companion_row from public.companions where id=p_companion_id and owner_id=actor.id and status not in ('DELETED','QUARANTINED') for update;
    if not found then raise exception using errcode='P0001',message='Companion not found for authenticated Owner'; end if;
    new_companion_id:=companion_row.id;
  end if;

  if companion_row.current_identity_version_id is not null then
    select * into current_identity from public.companion_identities
    where id=companion_row.current_identity_version_id and companion_id=companion_row.id and owner_id=actor.id;
  end if;
  next_version:=coalesce(current_identity.version,0)+1;
  source_manifest:=jsonb_build_object(
    'importId',import_row.id,'originalSha256',import_row.original_sha256,
    'parserVersion',import_row.parser_version,'policyVersion',import_row.policy_version,
    'approvedCandidateIds',(select jsonb_agg(x order by x) from unnest(p_approved_candidate_ids) x)
  );
  content_hash:=encode(sha256(convert_to((jsonb_build_object(
    'companionId',new_companion_id,'version',next_version,'displayName',display_name,
    'identityDocument',identity_doc,'sourceManifest',source_manifest
  ))::text,'UTF8')),'hex');

  insert into public.companion_identities(
    id,owner_id,companion_id,version,display_name,identity_document,source_manifest,content_hash,
    created_by,approved_by_owner_at,supersedes_identity_id
  ) values(
    new_identity_id,actor.id,new_companion_id,next_version,display_name,identity_doc,source_manifest,content_hash,
    'IMPORT_FIREWALL',approved_at,current_identity.id
  ) returning * into identity_row;

  update public.companions set current_identity_version_id=new_identity_id,updated_at=approved_at
  where id=new_companion_id and owner_id=actor.id;

  -- The approved memories, in card order, after the ones the Companion already has.
  if cardinality(memories)>0 then
    if (select count(*) from companion_private.companion_memories where companion_id=new_companion_id)+cardinality(memories)>200 then
      raise exception using errcode='55000',message='memory limit reached';
    end if;
    insert into companion_private.companion_memories(companion_id,body,source,import_id,created_at)
    select new_companion_id,m,'IMPORT',import_row.id,approved_at+(i*interval '1 microsecond')
    from unnest(memories) with ordinality t(m,i);
  end if;

  -- The approved world book entries, in card order, after the ones the Companion already has. An
  -- entry it already has word for word (the same card approved into it again) is not added twice.
  select coalesce(jsonb_agg(w order by i),'[]') into world from jsonb_array_elements(world) with ordinality t(w,i)
    where not exists(select 1 from companion_private.world_entries e where e.companion_id=new_companion_id
      and e.body=w->>'body' and e.keys=array(select jsonb_array_elements_text(w->'keys')));
  if jsonb_array_length(world)>0 then
    if (select count(*) from companion_private.world_entries where companion_id=new_companion_id)+jsonb_array_length(world)>100 then
      raise exception using errcode='55000',message='world entry limit reached';
    end if;
    insert into companion_private.world_entries(companion_id,keys,body,source,import_id,created_at,updated_at)
    select new_companion_id,array(select jsonb_array_elements_text(w->'keys')),w->>'body','IMPORT',import_row.id,
      approved_at+(i*interval '1 microsecond'),approved_at
    from jsonb_array_elements(world) with ordinality t(w,i);
  end if;

  update companion_private.companion_imports set
    companion_id=new_companion_id,status='APPROVED',
    status_history=status_history||'"APPROVED"'::jsonb,approved_identity_id=new_identity_id,updated_at=approved_at
  where id=import_row.id and owner_id=actor.id;

  insert into companion_private.approval_idempotency(owner_id,idempotency_key_hash,request_hash,identity_id)
  values(actor.id,p_idempotency_key_hash,p_request_hash,new_identity_id);

  insert into public.audit_events(id,owner_id,companion_id,actor_type,actor_id,action,target_type,target_id,after_hash,occurred_at)
  values(gen_random_uuid(),actor.id,new_companion_id,'OWNER',actor.id,'COMPANION_IDENTITY_APPROVED','COMPANION_IDENTITY',new_identity_id,content_hash,approved_at);

  return query select companion_private.identity_payload(identity_row);
end $$;

-- Same as in 0060, plus the Companion's world book.
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
  delete from companion_private.world_entries where companion_id = c;
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

-- ---------- 1. example dialogue ----------

-- As in 0064, plus dialogueExamples: a text like identitySummary, up to 1500 characters.
create or replace function public.persona_save(p_companion uuid, p_version integer, p_fields jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
  cur public.companion_identities%rowtype; doc jsonb; k text; v text;
  new_id uuid := gen_random_uuid(); manifest jsonb; hash text; at timestamptz := now();
begin
  if p_version is null or p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'
    or exists(select 1 from jsonb_each(p_fields) f
      where f.key not in ('identitySummary', 'personaTraits', 'speakingStyle', 'values', 'boundaries', 'aspirations', 'dialogueExamples')
        or jsonb_typeof(f.value) <> 'string'
        or char_length(f.value #>> '{}') > case f.key when 'dialogueExamples' then 1500 else 600 end) then
    raise exception using errcode='22023', message='invalid persona';
  end if;
  -- Waits for a deletion that is under way, and then finds the Companion gone instead of writing into it.
  perform 1 from public.companions where id = c and status <> 'DELETED' for no key update;
  if not found then raise exception using errcode='P0001', message='companion not found'; end if;
  select i.* into cur from public.companions x join public.companion_identities i on i.id = x.current_identity_version_id
    where x.id = c;
  if cur.version <> p_version then raise exception using errcode='23505', message='persona version conflict'; end if;

  doc := cur.identity_document;
  for k, v in select f.key, btrim(f.value #>> '{}', E' \t\r\n') from jsonb_each(p_fields) f loop
    -- Stored in the shape an import gives the same field: a text, or a list of texts.
    doc := case when v = '' then doc - k
      when k in ('identitySummary', 'speakingStyle', 'dialogueExamples') then doc || jsonb_build_object(k, v)
      else doc || jsonb_build_object(k, jsonb_build_array(v)) end;
  end loop;
  if doc = cur.identity_document then return public.persona_get(c); end if;

  if (select count(*) from public.companion_identities where companion_id = c and created_at > at - interval '1 hour') >= 30 then
    raise exception using errcode='55000', message='too many persona changes';
  end if;
  manifest := jsonb_build_object('editedBy', 'OWNER', 'basedOnVersion', cur.version,
    'fields', (select jsonb_agg(f.key order by f.key) from jsonb_each(p_fields) f));
  hash := encode(sha256(convert_to((jsonb_build_object('companionId', c, 'version', cur.version + 1, 'displayName', cur.display_name,
    'identityDocument', doc, 'sourceManifest', manifest))::text, 'UTF8')), 'hex');
  insert into public.companion_identities(id, owner_id, companion_id, version, display_name, identity_document, source_manifest,
      content_hash, created_by, approved_by_owner_at, supersedes_identity_id)
    values (new_id, o, c, cur.version + 1, cur.display_name, doc, manifest, hash, 'OWNER', at, cur.id);
  update public.companions set current_identity_version_id = new_id, updated_at = at where id = c;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id, before_hash, after_hash)
    values (o, c, 'OWNER', o, 'COMPANION_PERSONA_EDITED', 'COMPANION_IDENTITY', new_id, cur.content_hash, hash);
  return public.persona_get(c);
end $$;

-- ---------- 3. rules over what it says ----------

alter table companion_private.chat_settings
  add column reply_rules jsonb not null default '[]';

-- The shape of the list, whoever stores it (chat_update_settings can be called without the API
-- server): up to 10 rules, each exactly {pattern, flags, replacement, enabled} of the right kinds
-- and lengths. Whether a pattern compiles is the API server's to say, when it saves a list and again
-- before it runs one.
create function companion_private.reply_rules_ok(p jsonb)
returns boolean language sql immutable as $$
  select case when jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) > 10 then false
    else not exists(select 1 from jsonb_array_elements(p) r where case when jsonb_typeof(r) <> 'object' then true else
      r - array['pattern', 'flags', 'replacement', 'enabled'] <> '{}'::jsonb
      or jsonb_typeof(r->'pattern') is distinct from 'string' or char_length(r->>'pattern') not between 1 and 200
      or jsonb_typeof(r->'flags') is distinct from 'string' or r->>'flags' !~ '^[gimsu]{0,5}$'
      or jsonb_typeof(r->'replacement') is distinct from 'string' or char_length(r->>'replacement') > 200
      or jsonb_typeof(r->'enabled') is distinct from 'boolean' end) end
$$;
revoke all on function companion_private.reply_rules_ok(jsonb) from public, anon, authenticated;
alter table companion_private.chat_settings
  add constraint chat_settings_reply_rules_check check (companion_private.reply_rules_ok(reply_rules));

-- As in 0070, plus replyRules.
create or replace function companion_private.chat_settings_json(s companion_private.chat_settings)
returns jsonb language sql immutable as $$
  select jsonb_build_object('groupActivity', s.group_activity, 'companionInteraction', s.companion_interaction,
    'model', s.model, 'voice', s.voice, 'preferredUserTitle', s.owner_title, 'autoMemory', s.auto_memory,
    'proactive', s.proactive, 'replyRules', s.reply_rules, 'revision', s.revision)
$$;

drop function public.chat_update_settings(uuid, text, text, text, text, integer, text, text, text);
-- As in 0070, plus p_reply_rules: the whole list, checked by the API server ([] clears it). Null
-- keeps the current list: it comes last with a default, so the API server deployed before this
-- migration keeps working.
create function public.chat_update_settings(p_companion uuid, p_group_activity text, p_companion_interaction text,
  p_model text, p_voice text, p_revision integer, p_owner_title text default null, p_auto_memory text default null,
  p_proactive text default null, p_reply_rules jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.chat_settings%rowtype; o uuid := companion_private.chat_owner();
begin
  s := companion_private.chat_settings_for(p_companion);
  update companion_private.chat_settings set group_activity = p_group_activity,
    companion_interaction = p_companion_interaction, model = p_model, voice = p_voice,
    owner_title = case when p_owner_title is null then owner_title else nullif(btrim(p_owner_title), '') end,
    auto_memory = coalesce(p_auto_memory, auto_memory), proactive = coalesce(p_proactive, proactive),
    reply_rules = coalesce(p_reply_rules, reply_rules),
    revision = revision + 1
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='chat settings revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'CHAT_UPDATE_SETTINGS', 'COMPANION', s.companion_id);
  return companion_private.chat_settings_json(s);
end $$;

revoke all on function companion_private.world_json(companion_private.world_entries),
  public.world_list(uuid), public.world_save(uuid, uuid, text[], text, boolean), public.world_delete(uuid, uuid),
  public.chat_update_settings(uuid, text, text, text, text, integer, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.world_list(uuid), public.world_delete(uuid, uuid),
  public.chat_update_settings(uuid, text, text, text, text, integer, text, text, text, jsonb) to authenticated;
grant execute on function public.world_save(uuid, uuid, text[], text, boolean) to companion_api;

insert into companion_private.schema_migrations(name) values ('202611270072_persona_depth');

commit;
