begin;

-- Two fixes to Owner-callable functions, each redefined from its latest version with one change.
--
-- 1. project_and_activate_social_twin (from 0025) set the Social Twin's status to ACTIVE every
--    time, so an Owner could lift an operator's SUSPENDED or LIMITED by re-projecting. It now
--    keeps the current status; only a brand-new twin starts ACTIVE.
--
-- 2. update_companion_controls (from 0021) stored socialTwinVisibility only in companion_controls,
--    which nothing has read since 0027: every reader checks the active Social Persona's
--    profile_visibility. Personas are immutable, so a visibility change now activates a copy of
--    the current persona with only the visibility (and version, hash) changed, the same as
--    re-projecting. The Companion row is locked first, in the same order as projection.

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
      set active_social_persona_id=persona_row.id,autonomy_mode=p_autonomy_mode,updated_at=approved_at -- status kept (fix 1)
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

create or replace function public.update_companion_controls(
  p_companion_id uuid,
  p_if_match bigint,
  p_patch jsonb,
  p_idempotency_key_hash text,
  p_request_hash text
) returns table(payload jsonb)
language plpgsql security definer set search_path='' as $$
declare actor public.owners%rowtype; controls public.companion_controls%rowtype; existing companion_private.controls_idempotency%rowtype; result jsonb;
  twin_row public.social_twins%rowtype; persona_row public.social_personas%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_if_match is null or p_if_match<1 or p_patch is null or jsonb_typeof(p_patch)<>'object'
    or p_patch='{}'::jsonb or p_idempotency_key_hash!~'^[a-f0-9]{64}$' or p_request_hash!~'^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='invalid Controls update request';
  end if;
  if exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('socialTwinVisibility','socialAutonomyMode','memorySharingScope','notificationsEnabled')) then
    raise exception using errcode='22023',message='unsupported Controls field';
  end if;
  if p_patch?'socialTwinVisibility' and p_patch->>'socialTwinVisibility' not in ('PRIVATE','FRIENDS','PUBLIC') then
    raise exception using errcode='22023',message='invalid Social Twin visibility';
  end if;
  if p_patch?'socialAutonomyMode' and p_patch->>'socialAutonomyMode' not in ('QUIET','NORMAL','ACTIVE','CUSTOM') then
    raise exception using errcode='22023',message='invalid social autonomy mode';
  end if;
  if p_patch?'memorySharingScope' and p_patch->>'memorySharingScope'<>'PERMISSION_GATED_SOCIAL_ONLY' then
    raise exception using errcode='22023',message='unsupported Memory sharing scope';
  end if;
  if p_patch?'notificationsEnabled' and jsonb_typeof(p_patch->'notificationsEnabled')<>'boolean' then
    raise exception using errcode='22023',message='invalid notification preference';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.controls_idempotency where owner_id=actor.id and idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.companion_id<>p_companion_id or existing.request_hash<>p_request_hash then
      raise exception using errcode='23505',message='Controls idempotency key reused with a different request';
    end if;
    return query select existing.result_payload; return;
  end if;

  perform 1 from public.companions where id=p_companion_id and owner_id=actor.id for update; -- fix 2: projection's lock order
  controls:=companion_private.ensure_companion_controls(actor.id,p_companion_id);
  if controls.revision<>p_if_match then raise exception using errcode='23505',message='stale Controls revision'; end if;

  update public.companion_controls set
    social_twin_visibility=case when p_patch?'socialTwinVisibility' then p_patch->>'socialTwinVisibility' else controls.social_twin_visibility end,
    social_autonomy_mode=case when p_patch?'socialAutonomyMode' then p_patch->>'socialAutonomyMode' else controls.social_autonomy_mode end,
    memory_sharing_scope=case when p_patch?'memorySharingScope' then p_patch->>'memorySharingScope' else controls.memory_sharing_scope end,
    notifications_enabled=case when p_patch?'notificationsEnabled' then (p_patch->>'notificationsEnabled')::boolean else controls.notifications_enabled end,
    revision=controls.revision+1,
    updated_at=statement_timestamp()
  where owner_id=actor.id and companion_id=p_companion_id
  returning * into controls;

  if p_patch?'socialAutonomyMode' then
    update public.social_twins set autonomy_mode=controls.social_autonomy_mode,updated_at=statement_timestamp()
    where owner_id=actor.id and companion_id=p_companion_id;
  end if;

  -- fix 2: a visibility change activates a copy of the current persona with that visibility.
  select * into twin_row from public.social_twins where owner_id=actor.id and companion_id=p_companion_id for update;
  if found then
    select * into persona_row from public.social_personas where id=twin_row.active_social_persona_id;
    if persona_row.profile_visibility<>controls.social_twin_visibility then
      persona_row.supersedes_social_persona_id:=persona_row.id;
      persona_row.id:=gen_random_uuid();
      persona_row.version:=(select max(version)+1 from public.social_personas where companion_id=p_companion_id);
      persona_row.profile_visibility:=controls.social_twin_visibility;
      persona_row.approved_by_owner_at:=statement_timestamp();
      persona_row.created_at:=statement_timestamp();
      persona_row.content_hash:=encode(public.digest(jsonb_build_object(
        'companionId',persona_row.companion_id,'version',persona_row.version,'handle',persona_row.handle,
        'displayName',persona_row.display_name,'publicDocument',persona_row.public_document,
        'profileVisibility',persona_row.profile_visibility,'sourceIdentityVersionId',persona_row.source_identity_version_id,
        'sourceIdentityVersion',persona_row.source_identity_version,'projectionManifest',persona_row.projection_manifest
      )::text,'sha256'),'hex');
      insert into public.social_personas select (persona_row).*;
      update public.social_twins set active_social_persona_id=persona_row.id,updated_at=statement_timestamp() where id=twin_row.id;
      insert into public.audit_events(id,owner_id,companion_id,actor_type,actor_id,action,target_type,target_id,after_hash,occurred_at)
      values(gen_random_uuid(),actor.id,p_companion_id,'OWNER',actor.id,'SOCIAL_PERSONA_VISIBILITY_CHANGED','SOCIAL_PERSONA',
        persona_row.id,persona_row.content_hash,statement_timestamp());
    end if;
  end if;

  result:=companion_private.controls_payload(controls);
  insert into companion_private.controls_idempotency(owner_id,companion_id,idempotency_key_hash,request_hash,result_revision,result_payload)
  values(actor.id,p_companion_id,p_idempotency_key_hash,p_request_hash,controls.revision,result);
  return query select result;
end $$;

commit;
