begin;

create or replace function companion_private.get_encounter_preparation(
  p_actor_owner_id uuid, p_invitation_id uuid
) returns table(
  initiator_owner_id uuid, initiator_twin_id uuid,
  responder_owner_id uuid, responder_companion_id uuid, responder_twin_id uuid,
  responder_social_persona_version integer, responder_identity_version integer
)
language plpgsql stable security definer set search_path='' as $$
declare i public.encounter_invitations%rowtype; it public.social_twins%rowtype; rt public.social_twins%rowtype;
begin
  select invitation.* into i
  from public.encounter_invitations invitation
  where invitation.id=p_invitation_id and invitation.initiator_owner_id=p_actor_owner_id;
  if not found then raise exception using errcode='P0001',message='Encounter invitation not found for initiating Owner'; end if;
  if i.status<>'APPROVED' or i.claimed_at is not null or i.used_at is not null or i.expires_at<=statement_timestamp()
    or not i.approved_by_owner_ids @> array[i.initiator_owner_id,i.responder_owner_id] then
    raise exception using errcode='55000',message='Encounter invitation is not approved and claimable';
  end if;
  select twin.* into it
  from public.social_twins twin
  where twin.id=i.initiator_twin_id and twin.owner_id=i.initiator_owner_id and twin.status='ACTIVE';
  select twin.* into rt
  from public.social_twins twin
  where twin.id=i.responder_twin_id and twin.owner_id=i.responder_owner_id and twin.status='ACTIVE';
  if it.id is null or rt.id is null then raise exception using errcode='55000',message='Encounter Social Twin is inactive'; end if;
  if not exists(select 1 from public.social_personas p where p.id=i.initiator_social_persona_id and p.id=it.active_social_persona_id and p.version=i.initiator_social_persona_version and p.source_identity_version_id=i.initiator_identity_version_id and p.source_identity_version=i.initiator_identity_version)
    or not exists(select 1 from public.social_personas p where p.id=i.responder_social_persona_id and p.id=rt.active_social_persona_id and p.version=i.responder_social_persona_version and p.source_identity_version_id=i.responder_identity_version_id and p.source_identity_version=i.responder_identity_version) then
    raise exception using errcode='55000',message='Encounter frozen identity version is no longer active';
  end if;
  return query select i.initiator_owner_id,i.initiator_twin_id,i.responder_owner_id,rt.companion_id,i.responder_twin_id,i.responder_social_persona_version,i.responder_identity_version;
end $$;

revoke all on function companion_private.get_encounter_preparation(uuid,uuid) from public,anon,authenticated;
grant execute on function companion_private.get_encounter_preparation(uuid,uuid) to service_role;

commit;
