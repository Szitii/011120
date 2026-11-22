begin;

create table companion_private.social_projection_idempotency (
  owner_id uuid not null references public.owners(id) on delete cascade,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  persona_id uuid not null,
  twin_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner_id,idempotency_key_hash),
  foreign key (persona_id) references public.social_personas(id),
  foreign key (twin_id) references public.social_twins(id)
);

create or replace function companion_private.social_projection_payload(
  p_persona public.social_personas,
  p_twin public.social_twins
) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'persona',jsonb_strip_nulls(jsonb_build_object(
      'id',p_persona.id,
      'companionId',p_persona.companion_id,
      'version',p_persona.version,
      'handle',p_persona.handle,
      'displayName',p_persona.display_name,
      'bio',p_persona.public_document->>'bio',
      'publicTraits',coalesce(p_persona.public_document->'publicTraits','[]'::jsonb),
      'publicVoice',coalesce(p_persona.public_document->'publicVoice','{}'::jsonb),
      'publicInterests',coalesce(p_persona.public_document->'publicInterests','[]'::jsonb),
      'publicBoundaries',coalesce(p_persona.public_document->'publicBoundaries','[]'::jsonb),
      'profileVisibility',p_persona.profile_visibility,
      'sourceIdentityVersionId',p_persona.source_identity_version_id,
      'sourceIdentityVersion',p_persona.source_identity_version,
      'projectionManifest',p_persona.projection_manifest,
      'supersedesSocialPersonaId',p_persona.supersedes_social_persona_id,
      'contentHash',p_persona.content_hash,
      'approvedByOwnerAt',p_persona.approved_by_owner_at
    )),
    'twin',jsonb_build_object(
      'id',p_twin.id,
      'companionId',p_twin.companion_id,
      'activeSocialPersonaId',p_twin.active_social_persona_id,
      'status',p_twin.status,
      'autonomyMode',p_twin.autonomy_mode,
      'socialMemoryNamespaceId',p_twin.social_memory_namespace_id,
      'createdAt',p_twin.created_at,
      'updatedAt',p_twin.updated_at
    )
  )
$$;

create or replace function public.project_and_activate_social_twin(
  p_companion_id uuid,
  p_source_identity_version_id uuid,
  p_handle text,
  p_profile_visibility text,
  p_autonomy_mode text,
  p_selections jsonb,
  p_idempotency_key_hash text,
  p_request_hash text
) returns table(payload jsonb)
language plpgsql security definer set search_path='' as $$
declare
  actor public.owners%rowtype;
  companion_row public.companions%rowtype;
  identity_row public.companion_identities%rowtype;
  previous_persona public.social_personas%rowtype;
  persona_row public.social_personas%rowtype;
  twin_row public.social_twins%rowtype;
  replay companion_private.social_projection_idempotency%rowtype;
  selection jsonb;
  source_field text;
  target_field text;
  source_value jsonb;
  manifest jsonb:='[]'::jsonb;
  public_doc jsonb:='{}'::jsonb;
  display_name text;
  normalized_handle text:=lower(btrim(p_handle));
  next_version integer;
  new_persona_id uuid:=gen_random_uuid();
  new_twin_id uuid:=gen_random_uuid();
  persona_hash text;
  approved_at timestamptz:=statement_timestamp();
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;

  if p_idempotency_key_hash!~'^[a-f0-9]{64}$' or p_request_hash!~'^[a-f0-9]{64}$'
    or normalized_handle!~'^[a-z0-9_]{3,30}$'
    or p_profile_visibility not in ('PRIVATE','FRIENDS','PUBLIC')
    or p_autonomy_mode not in ('QUIET','NORMAL','ACTIVE','CUSTOM')
    or p_selections is null or jsonb_typeof(p_selections)<>'array' or jsonb_array_length(p_selections)<1 then
    raise exception using errcode='22023',message='invalid Social Persona projection request';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into replay from companion_private.social_projection_idempotency
   where owner_id=actor.id and idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if replay.request_hash<>p_request_hash then
      raise exception using errcode='23505',message='Social projection idempotency key reused with a different request';
    end if;
    select * into persona_row from public.social_personas where id=replay.persona_id and owner_id=actor.id;
    select * into twin_row from public.social_twins where id=replay.twin_id and owner_id=actor.id;
    return query select companion_private.social_projection_payload(persona_row,twin_row);
    return;
  end if;

  select * into companion_row from public.companions
   where id=p_companion_id and owner_id=actor.id and status not in ('DELETED','QUARANTINED')
   for update;
  if not found then raise exception using errcode='P0001',message='Companion not found for authenticated Owner'; end if;

  select * into identity_row from public.companion_identities
   where id=p_source_identity_version_id
     and companion_id=companion_row.id
     and owner_id=actor.id;
  if not found then raise exception using errcode='P0001',message='Companion identity not found'; end if;
  if companion_row.current_identity_version_id<>identity_row.id then
    raise exception using errcode='23505',message='Social Persona must project from current approved identity';
  end if;

  if exists(
    select 1 from public.social_handles h
    where h.handle=normalized_handle and h.companion_id<>p_companion_id
  ) then raise exception using errcode='23505',message='Social handle is already in use'; end if;

  if exists(
    select 1 from public.social_handles h
    where h.companion_id=p_companion_id and h.handle<>normalized_handle
  ) then raise exception using errcode='23505',message='Existing Companion social handle cannot be silently replaced'; end if;

  for selection in select value from jsonb_array_elements(p_selections) loop
    source_field:=selection->>'sourceField';
    target_field:=selection->>'targetField';
    if source_field is null or target_field is null then
      raise exception using errcode='22023',message='Projection selection is incomplete';
    end if;
    if not (
      (source_field='displayName' and target_field='displayName') or
      (source_field='identitySummary' and target_field='bio') or
      (source_field='personaTraits' and target_field='publicTraits') or
      (source_field='speakingStyle' and target_field='publicVoice') or
      (source_field='values' and target_field='publicInterests') or
      (source_field='boundaries' and target_field='publicBoundaries')
    ) then raise exception using errcode='22023',message='Projection mapping is not allowlisted'; end if;

    if exists(select 1 from jsonb_array_elements(manifest) m where m->>'targetField'=target_field) then
      raise exception using errcode='22023',message='A public projection target may appear only once';
    end if;

    source_value:=case source_field
      when 'displayName' then to_jsonb(identity_row.display_name)
      else identity_row.identity_document->source_field
    end;
    if source_value is null or source_value='null'::jsonb then
      raise exception using errcode='22023',message='Selected identity field has no approved value';
    end if;

    if target_field='displayName' then
      display_name:=trim(both '"' from source_value::text);
    else
      public_doc:=public_doc||jsonb_build_object(target_field,source_value);
    end if;

    manifest:=manifest||jsonb_build_array(jsonb_build_object(
      'sourceField',source_field,
      'targetField',target_field,
      'sourceValueHash',encode(public.digest(source_value::text,'sha256'),'hex')
    ));
  end loop;

  if display_name is null or btrim(display_name)='' then
    raise exception using errcode='22023',message='Display name requires explicit projection selection';
  end if;

  select * into previous_persona
    from public.social_personas
   where companion_id=p_companion_id and owner_id=actor.id
   order by version desc limit 1;
  next_version:=coalesce(previous_persona.version,0)+1;

  insert into public.social_handles(handle,owner_id,companion_id)
  values(normalized_handle,actor.id,p_companion_id)
  on conflict(handle) do nothing;

  persona_hash:=encode(public.digest(jsonb_build_object(
    'companionId',p_companion_id,
    'version',next_version,
    'handle',normalized_handle,
    'displayName',display_name,
    'publicDocument',public_doc,
    'profileVisibility',p_profile_visibility,
    'sourceIdentityVersionId',identity_row.id,
    'sourceIdentityVersion',identity_row.version,
    'projectionManifest',manifest
  )::text,'sha256'),'hex');

  insert into public.social_personas(
    id,owner_id,companion_id,version,handle,display_name,public_document,profile_visibility,
    source_identity_version_id,source_identity_version,source_identity_content_hash,projection_manifest,
    supersedes_social_persona_id,content_hash,approved_by_owner_at
  ) values(
    new_persona_id,actor.id,p_companion_id,next_version,normalized_handle,display_name,public_doc,p_profile_visibility,
    identity_row.id,identity_row.version,identity_row.content_hash,manifest,
    previous_persona.id,persona_hash,approved_at
  ) returning * into persona_row;

  select * into twin_row from public.social_twins
   where companion_id=p_companion_id and owner_id=actor.id for update;
  if found then
    update public.social_twins
      set active_social_persona_id=persona_row.id,status='ACTIVE',autonomy_mode=p_autonomy_mode,updated_at=approved_at
      where id=twin_row.id
      returning * into twin_row;
  else
    insert into public.social_twins(id,owner_id,companion_id,active_social_persona_id,status,autonomy_mode,created_at,updated_at)
    values(new_twin_id,actor.id,p_companion_id,persona_row.id,'ACTIVE',p_autonomy_mode,approved_at,approved_at)
    returning * into twin_row;
  end if;

  insert into public.companion_controls(
    owner_id,companion_id,social_twin_visibility,social_autonomy_mode,memory_sharing_scope,notifications_enabled,updated_at
  ) values(
    actor.id,p_companion_id,p_profile_visibility,p_autonomy_mode,'PERMISSION_GATED_SOCIAL_ONLY',true,approved_at
  )
  on conflict(owner_id,companion_id) do update set
    social_twin_visibility=excluded.social_twin_visibility,
    social_autonomy_mode=excluded.social_autonomy_mode,
    revision=public.companion_controls.revision+1,
    updated_at=excluded.updated_at;

  insert into companion_private.social_projection_idempotency(
    owner_id,idempotency_key_hash,request_hash,persona_id,twin_id
  ) values(actor.id,p_idempotency_key_hash,p_request_hash,persona_row.id,twin_row.id);

  insert into public.audit_events(id,owner_id,companion_id,actor_type,actor_id,action,target_type,target_id,after_hash,occurred_at)
  values
    (gen_random_uuid(),actor.id,p_companion_id,'OWNER',actor.id,'SOCIAL_PERSONA_PROJECTED','SOCIAL_PERSONA',persona_row.id,persona_row.content_hash,approved_at),
    (gen_random_uuid(),actor.id,p_companion_id,'OWNER',actor.id,'SOCIAL_PERSONA_ACTIVATED','SOCIAL_TWIN',twin_row.id,
      encode(public.digest(jsonb_build_object('activeSocialPersonaId',twin_row.active_social_persona_id,'autonomyMode',twin_row.autonomy_mode,'status',twin_row.status)::text,'sha256'),'hex'),
      approved_at);

  return query select companion_private.social_projection_payload(persona_row,twin_row);
end $$;

revoke all on table companion_private.social_projection_idempotency from public,anon,authenticated;
revoke all on function companion_private.social_projection_payload(public.social_personas,public.social_twins) from public,anon,authenticated;
grant execute on function companion_private.social_projection_payload(public.social_personas,public.social_twins) to service_role;
revoke all on function public.project_and_activate_social_twin(uuid,uuid,text,text,text,jsonb,text,text) from public,anon;
grant execute on function public.project_and_activate_social_twin(uuid,uuid,text,text,text,jsonb,text,text) to authenticated,service_role;

comment on function public.project_and_activate_social_twin(uuid,uuid,text,text,text,jsonb,text,text) is
  'Projects only Owner-selected allowlisted identity fields into an immutable Social Persona, then creates or reactivates the stable Social Twin principal.';

commit;
