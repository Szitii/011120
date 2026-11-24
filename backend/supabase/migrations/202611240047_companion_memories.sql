begin;

-- Long-term memory (长期记忆): short things a Companion remembers about its Owner and their life
-- together, used when it chats and writes its diary.
--
-- Only the Owner puts memories in: by hand, or by approving them one by one when importing a
-- character card (the card's `memories` list goes through the import firewall first, and a
-- memory with a credential, private data or a prompt injection cannot be approved). The model
-- never writes here by itself. The Owner can see and delete every memory.

create table companion_private.companion_memories (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references public.companions(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500 and body ~ '\S'),
  source text not null check (source in ('IMPORT', 'OWNER')),
  import_id uuid,
  -- The Owner's retry key for adding by hand, so a retried request does not add it twice.
  key_hash text check (key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  check ((source = 'IMPORT') = (import_id is not null)),
  check (source = 'OWNER' or key_hash is null),
  unique (companion_id, key_hash)
);
create index companion_memories_list on companion_private.companion_memories(companion_id, created_at desc, id desc);
alter table companion_private.companion_memories enable row level security;
alter table companion_private.companion_memories force row level security;
revoke all on companion_private.companion_memories from public, anon, authenticated;

create function companion_private.memory_json(m companion_private.companion_memories)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', m.id, 'body', m.body, 'source', m.source, 'createdAt', m.created_at)
$$;

create function companion_private.memory_companion(p_companion uuid)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  if not companion_private.chat_companion_ok(companion_private.chat_owner(), p_companion) then
    raise exception using errcode='P0001', message='companion not found';
  end if;
  return p_companion;
end $$;

-- Every memory of the Companion, newest first (at most 200).
create function public.memory_list(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.memory_companion(p_companion);
begin
  return jsonb_build_object('items', coalesce((select jsonb_agg(companion_private.memory_json(m) order by m.created_at desc, m.id desc)
    from companion_private.companion_memories m where m.companion_id = c), '[]'));
end $$;

-- The Owner adds one memory. The same key returns the first one; with other text it is a conflict.
create function public.memory_add(p_companion uuid, p_body text, p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.memory_companion(p_companion); m companion_private.companion_memories%rowtype;
  v_body text := btrim(p_body); o uuid := companion_private.chat_owner();
begin
  if v_body is null or v_body !~ '\S' or char_length(v_body) > 500 or p_key is null or p_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023', message='invalid memory';
  end if;
  perform 1 from public.companions where id = c for no key update;
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

-- Deleting is final: the text is gone.
create function public.memory_delete(p_companion uuid, p_memory uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.memory_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  delete from companion_private.companion_memories where id = p_memory and companion_id = c;
  if not found then raise exception using errcode='P0001', message='memory not found'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'MEMORY_DELETE', 'MEMORY', p_memory);
  return jsonb_build_object('deleted', true);
end $$;

-- Same as in 0022, except approved `memory` candidates become the Companion's memories instead of
-- identity fields (at most 200 memories per Companion).
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

revoke all on function companion_private.memory_json(companion_private.companion_memories), companion_private.memory_companion(uuid)
  from public, anon, authenticated;
revoke all on function public.memory_list(uuid), public.memory_add(uuid, text, text), public.memory_delete(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.memory_list(uuid), public.memory_add(uuid, text, text), public.memory_delete(uuid, uuid) to authenticated;

commit;
