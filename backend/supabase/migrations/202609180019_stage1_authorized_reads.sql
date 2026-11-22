begin;

create or replace function public.get_active_identity_context(
  p_subject_kind text default 'OWNER',
  p_subject_id uuid default null
) returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare
  actor public.owners%rowtype;
  companion public.companions%rowtype;
  twin public.social_twins%rowtype;
  persona public.social_personas%rowtype;
  identity public.companion_identities%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_subject_kind='OWNER' then
    if p_subject_id is not null and p_subject_id<>actor.id then raise exception using errcode='42501',message='active subject is outside Owner scope'; end if;
    return query select jsonb_build_object(
      'viewer',jsonb_build_object('ownerId',actor.id),
      'activeSubject',jsonb_build_object('kind','OWNER','id',actor.id),
      'relationship','SELF','viewMode','OWNER',
      'capabilities',jsonb_build_object('readWorld',true,'readProfile',true,'readEncounter',true,'readLifeEvents',true,'bringCompanion',true,'updateControls',true)
    ); return;
  end if;
  if p_subject_id is null then raise exception using errcode='22023',message='active subject id is required'; end if;
  if p_subject_kind='COMPANION' then
    select * into companion from public.companions where id=p_subject_id and owner_id=actor.id and status not in ('DELETED','QUARANTINED');
    if not found then raise exception using errcode='P0001',message='active subject not found'; end if;
    select * into identity from public.companion_identities where id=companion.current_identity_version_id and companion_id=companion.id;
    select * into twin from public.social_twins where companion_id=companion.id and owner_id=actor.id;
    if twin.id is not null then select * into persona from public.social_personas where id=twin.active_social_persona_id; end if;
    return query select jsonb_build_object(
      'viewer',jsonb_build_object('ownerId',actor.id),
      'activeSubject',jsonb_strip_nulls(jsonb_build_object('kind','COMPANION','id',companion.id,'identityVersion',identity.version,'socialPersonaVersion',persona.version)),
      'relationship','OWNER_OF','viewMode','COMPANION',
      'capabilities',jsonb_build_object('readWorld',true,'readProfile',true,'readEncounter',true,'readLifeEvents',true,'bringCompanion',true,'updateControls',true)
    ); return;
  end if;
  if p_subject_kind='SOCIAL_TWIN' then
    select * into twin from public.social_twins where id=p_subject_id and owner_id=actor.id and status<>'SUSPENDED';
    if not found then raise exception using errcode='P0001',message='active subject not found'; end if;
    select * into companion from public.companions where id=twin.companion_id and owner_id=actor.id;
    select * into identity from public.companion_identities where id=companion.current_identity_version_id and companion_id=companion.id;
    select * into persona from public.social_personas where id=twin.active_social_persona_id;
    return query select jsonb_build_object(
      'viewer',jsonb_build_object('ownerId',actor.id),
      'activeSubject',jsonb_build_object('kind','SOCIAL_TWIN','id',twin.id,'identityVersion',identity.version,'socialPersonaVersion',persona.version),
      'relationship','OWNER_OF','viewMode','COMPANION',
      'capabilities',jsonb_build_object('readWorld',true,'readProfile',true,'readEncounter',true,'readLifeEvents',true,'bringCompanion',true,'updateControls',true)
    ); return;
  end if;
  raise exception using errcode='22023',message='invalid active subject kind';
end $$;

create or replace function public.list_world_items(
  p_limit integer default 20,
  p_before_created_at timestamptz default null
) returns table(item jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_limit<1 or p_limit>50 then raise exception using errcode='22023',message='invalid world page size'; end if;
  return query
  with candidates as (
    select le.id, 'LIFE_EVENT'::text kind, le.title, le.created_at, le.companion_id,
      le.id linked_id, 'AVAILABLE'::text status
    from public.life_events le where le.owner_id=actor.id and (p_before_created_at is null or le.created_at<p_before_created_at)
    union all
    select c.encounter_id, 'ENCOUNTER'::text,
      case when ei.purpose is null then 'Encounter' else left(ei.purpose,200) end,
      coalesce(ei.used_at,ei.claimed_at,ei.created_at), null::uuid,
      c.encounter_id, c.result_status
    from companion_private.encounter_idempotency c
    join public.encounter_invitations ei on ei.id=c.invitation_id
    where actor.id in(ei.initiator_owner_id,ei.responder_owner_id)
      and (p_before_created_at is null or coalesce(ei.used_at,ei.claimed_at,ei.created_at)<p_before_created_at)
  )
  select jsonb_build_object(
    'id',id,'kind',kind,'title',title,'createdAt',created_at,
    'actor',jsonb_strip_nulls(jsonb_build_object('companionId',companion_id)),
    'linkedObject',jsonb_build_object('type',kind,'id',linked_id),
    'status',status,'completeness','COMPLETE',
    'capabilities',jsonb_build_object('open',true)
  ) from candidates order by created_at desc,id desc limit p_limit;
end $$;

create or replace function public.get_companion_profile(p_companion_id uuid)
returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype; companion public.companions%rowtype; twin public.social_twins%rowtype; persona public.social_personas%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  select * into twin from public.social_twins where companion_id=p_companion_id and status<>'SUSPENDED';
  if not found then return; end if;
  select * into companion from public.companions where id=twin.companion_id;
  select * into persona from public.social_personas where id=twin.active_social_persona_id and companion_id=companion.id;
  if persona.id is null then return; end if;
  if companion.owner_id<>actor.id and persona.profile_visibility<>'PUBLIC' then return; end if;
  return query select jsonb_build_object(
    'companionId',companion.id,'socialTwinId',twin.id,'socialPersonaId',persona.id,
    'handle',persona.handle,'displayName',persona.display_name,'profileVisibility',persona.profile_visibility,
    'identityVersion',persona.source_identity_version,'socialPersonaVersion',persona.version,
    'publicProfile',persona.public_document,
    'viewer',jsonb_build_object(
      'relationship',case when companion.owner_id=actor.id then 'OWNER_OF' else 'PUBLIC_VIEWER' end,
      'capabilities',jsonb_build_object('view',true,'startEncounter',false,'follow',false,'friend',false)
    ),
    'completeness','COMPLETE'
  );
end $$;

create or replace function public.get_encounter_detail(p_encounter_id uuid)
returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype; terminal companion_private.encounter_idempotency%rowtype; invitation public.encounter_invitations%rowtype; artifact public.encounter_artifacts%rowtype; occurred timestamptz;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  select * into terminal from companion_private.encounter_idempotency where encounter_id=p_encounter_id;
  if not found then return; end if;
  select * into invitation from public.encounter_invitations where id=terminal.invitation_id and actor.id in(initiator_owner_id,responder_owner_id);
  if not found then return; end if;
  if terminal.artifact_id is not null then select * into artifact from public.encounter_artifacts where id=terminal.artifact_id; end if;
  occurred:=coalesce(artifact.created_at,invitation.used_at,invitation.claimed_at,invitation.created_at);
  return query select jsonb_strip_nulls(jsonb_build_object(
    'encounterId',terminal.encounter_id,'invitationId',invitation.id,'status',terminal.result_status,
    'initiatorTwinId',invitation.initiator_twin_id,'responderTwinId',invitation.responder_twin_id,
    'occurredAt',occurred,'body',artifact.body,'computeReceiptTransactionId',terminal.generation_transaction_id,
    'capabilities',jsonb_build_object('view',true),'completeness','COMPLETE'
  ));
end $$;

revoke all on function public.get_active_identity_context(text,uuid), public.list_world_items(integer,timestamptz), public.get_companion_profile(uuid), public.get_encounter_detail(uuid) from public, anon;
grant execute on function public.get_active_identity_context(text,uuid), public.list_world_items(integer,timestamptz), public.get_companion_profile(uuid), public.get_encounter_detail(uuid) to authenticated, service_role;

comment on function public.get_active_identity_context(text,uuid) is 'Reauthorizes the active Owner/Companion/Social Twin subject for each read.';
comment on function public.get_companion_profile(uuid) is 'Returns only Owner-authorized or explicitly public Social Twin projection data.';
comment on function public.get_encounter_detail(uuid) is 'Returns participant-authorized terminal Encounter details; nonparticipants are indistinguishable from absence.';

commit;
