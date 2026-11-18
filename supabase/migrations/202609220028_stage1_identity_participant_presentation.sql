begin;

alter table public.owners
  add column display_name text,
  add column avatar_url text;

alter table public.owners
  add constraint owners_display_name_length
    check (display_name is null or char_length(display_name) between 1 and 80),
  add constraint owners_avatar_url_length
    check (avatar_url is null or char_length(avatar_url) between 1 and 2048);

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
    if p_subject_id is not null and p_subject_id<>actor.id then
      raise exception using errcode='42501',message='active subject is outside Owner scope';
    end if;
    return query select jsonb_build_object(
      'viewer',jsonb_build_object('ownerId',actor.id),
      'activeSubject',jsonb_build_object(
        'kind','OWNER',
        'id',actor.id,
        'presentation',jsonb_strip_nulls(jsonb_build_object(
          'displayName',coalesce(actor.display_name,'Owner'),
          'avatar',actor.avatar_url
        ))
      ),
      'relationship','SELF','viewMode','OWNER',
      'capabilities',jsonb_build_object(
        'readWorld',true,'readProfile',true,'readEncounter',true,'readLifeEvents',true,
        'bringCompanion',true,'updateControls',true
      )
    );
    return;
  end if;

  if p_subject_id is null then
    raise exception using errcode='22023',message='active subject id is required';
  end if;

  if p_subject_kind='COMPANION' then
    select * into companion from public.companions
    where id=p_subject_id and owner_id=actor.id and status not in ('DELETED','QUARANTINED');
    if not found then raise exception using errcode='P0001',message='active subject not found'; end if;

    select * into identity from public.companion_identities
    where id=companion.current_identity_version_id and companion_id=companion.id;
    select * into twin from public.social_twins
    where companion_id=companion.id and owner_id=actor.id;
    if twin.id is not null then
      select * into persona from public.social_personas where id=twin.active_social_persona_id;
    end if;

    return query select jsonb_build_object(
      'viewer',jsonb_build_object('ownerId',actor.id),
      'activeSubject',jsonb_strip_nulls(jsonb_build_object(
        'kind','COMPANION',
        'id',companion.id,
        'identityVersion',identity.version,
        'socialPersonaVersion',persona.version,
        'presentation',jsonb_strip_nulls(jsonb_build_object(
          'displayName',coalesce(persona.display_name,identity.display_name,'Companion'),
          'avatar',case
            when jsonb_typeof(persona.public_document->'avatar')='string'
              then persona.public_document->>'avatar'
            else null
          end
        ))
      )),
      'relationship','OWNER_OF','viewMode','COMPANION',
      'capabilities',jsonb_build_object(
        'readWorld',true,'readProfile',true,'readEncounter',true,'readLifeEvents',true,
        'bringCompanion',true,'updateControls',true
      )
    );
    return;
  end if;

  if p_subject_kind='SOCIAL_TWIN' then
    select * into twin from public.social_twins
    where id=p_subject_id and owner_id=actor.id and status<>'SUSPENDED';
    if not found then raise exception using errcode='P0001',message='active subject not found'; end if;

    select * into companion from public.companions where id=twin.companion_id and owner_id=actor.id;
    select * into identity from public.companion_identities where id=companion.current_identity_version_id and companion_id=companion.id;
    select * into persona from public.social_personas where id=twin.active_social_persona_id;

    return query select jsonb_build_object(
      'viewer',jsonb_build_object('ownerId',actor.id),
      'activeSubject',jsonb_build_object(
        'kind','SOCIAL_TWIN','id',twin.id,
        'identityVersion',identity.version,'socialPersonaVersion',persona.version,
        'presentation',jsonb_strip_nulls(jsonb_build_object(
          'displayName',coalesce(persona.display_name,identity.display_name,'Companion'),
          'avatar',case
            when jsonb_typeof(persona.public_document->'avatar')='string'
              then persona.public_document->>'avatar'
            else null
          end
        ))
      ),
      'relationship','OWNER_OF','viewMode','COMPANION',
      'capabilities',jsonb_build_object(
        'readWorld',true,'readProfile',true,'readEncounter',true,'readLifeEvents',true,
        'bringCompanion',true,'updateControls',true
      )
    );
    return;
  end if;

  raise exception using errcode='22023',message='invalid active subject kind';
end $$;

create or replace function public.get_encounter_detail(p_encounter_id uuid)
returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare
  actor public.owners%rowtype;
  terminal companion_private.encounter_idempotency%rowtype;
  invitation public.encounter_invitations%rowtype;
  artifact public.encounter_artifacts%rowtype;
  initiator_twin public.social_twins%rowtype;
  responder_twin public.social_twins%rowtype;
  initiator_companion public.companions%rowtype;
  responder_companion public.companions%rowtype;
  initiator_persona public.social_personas%rowtype;
  responder_persona public.social_personas%rowtype;
  occurred timestamptz;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;

  select * into terminal from companion_private.encounter_idempotency where encounter_id=p_encounter_id;
  if not found then return; end if;

  select * into invitation from public.encounter_invitations
  where id=terminal.invitation_id and actor.id in(initiator_owner_id,responder_owner_id);
  if not found then return; end if;

  if terminal.artifact_id is not null then
    select * into artifact from public.encounter_artifacts where id=terminal.artifact_id;
  end if;

  select * into initiator_twin from public.social_twins where id=invitation.initiator_twin_id;
  select * into responder_twin from public.social_twins where id=invitation.responder_twin_id;
  select * into initiator_companion from public.companions where id=initiator_twin.companion_id;
  select * into responder_companion from public.companions where id=responder_twin.companion_id;
  select * into initiator_persona from public.social_personas where id=initiator_twin.active_social_persona_id;
  select * into responder_persona from public.social_personas where id=responder_twin.active_social_persona_id;

  occurred:=coalesce(artifact.created_at,invitation.used_at,invitation.claimed_at,invitation.created_at);

  return query select jsonb_strip_nulls(jsonb_build_object(
    'encounterId',terminal.encounter_id,
    'invitationId',invitation.id,
    'status',terminal.result_status,
    'initiatorTwinId',invitation.initiator_twin_id,
    'responderTwinId',invitation.responder_twin_id,
    'participants',jsonb_build_array(
      case
        when initiator_companion.owner_id=actor.id or initiator_persona.profile_visibility='PUBLIC'
          then jsonb_strip_nulls(jsonb_build_object(
            'role','INITIATOR','socialTwinId',initiator_twin.id,
            'presentationAvailable',true,'companionId',initiator_companion.id,
            'displayName',initiator_persona.display_name,'handle',initiator_persona.handle,
            'avatar',case when jsonb_typeof(initiator_persona.public_document->'avatar')='string'
              then initiator_persona.public_document->>'avatar' else null end,
            'profileAvailable',true
          ))
        else jsonb_build_object(
          'role','INITIATOR','socialTwinId',initiator_twin.id,
          'presentationAvailable',false,'profileAvailable',false
        )
      end,
      case
        when responder_companion.owner_id=actor.id or responder_persona.profile_visibility='PUBLIC'
          then jsonb_strip_nulls(jsonb_build_object(
            'role','RESPONDER','socialTwinId',responder_twin.id,
            'presentationAvailable',true,'companionId',responder_companion.id,
            'displayName',responder_persona.display_name,'handle',responder_persona.handle,
            'avatar',case when jsonb_typeof(responder_persona.public_document->'avatar')='string'
              then responder_persona.public_document->>'avatar' else null end,
            'profileAvailable',true
          ))
        else jsonb_build_object(
          'role','RESPONDER','socialTwinId',responder_twin.id,
          'presentationAvailable',false,'profileAvailable',false
        )
      end
    ),
    'occurredAt',occurred,'body',artifact.body,
    'computeReceiptTransactionId',terminal.generation_transaction_id,
    'capabilities',jsonb_build_object('view',true),
    'completeness','COMPLETE'
  ));
end $$;

revoke all on function public.get_active_identity_context(text,uuid), public.get_encounter_detail(uuid) from public, anon;
grant execute on function public.get_active_identity_context(text,uuid), public.get_encounter_detail(uuid) to authenticated, service_role;

comment on function public.get_active_identity_context(text,uuid) is
  'Reauthorizes active identity and returns only minimum safe presentation fields for the client identity slot.';
comment on function public.get_encounter_detail(uuid) is
  'Returns participant-authorized Encounter details. Counterpart presentation is exposed only for an owned Companion or a public Social Persona.';

commit;
