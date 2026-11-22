begin;

-- A block now covers the blocked person, not one of their identities. When actor X blocks actor Y,
-- X and every actor of Y's Owner stop seeing each other, so Y cannot come back as their AI (or
-- their human). X's own other identities keep their own block lists, as before. Blocks between
-- actors of the same Owner hide nothing.
create or replace function companion_private.community_visible(p_actor uuid,p_viewer uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select companion_private.community_profile_available(p_actor,p_viewer)
    and not exists(
      select 1 from public.community_actors pa, public.community_actors pv, public.community_blocks b
        join public.community_actors t on t.id=b.target_id
      where pa.id=p_actor and pv.id=p_viewer and pa.owner_id<>pv.owner_id
        and ((b.actor_id=p_viewer and t.owner_id=pa.owner_id) or (b.actor_id=p_actor and t.owner_id=pv.owner_id)))
$$;

-- Encounter invitations are between Owners: any block between the two Owners' actors, either way,
-- refuses one, with the same error as an inactive responder so the block is not revealed.
-- Redefined from 0015 with that one check added after the responder lookup.
create or replace function public.issue_encounter_invitation(
  p_initiator_twin_id uuid, p_responder_twin_id uuid,
  p_initiator_social_persona_id uuid, p_responder_social_persona_id uuid,
  p_initiator_identity_version_id uuid, p_responder_identity_version_id uuid,
  p_purpose text, p_scope text, p_context_hash text, p_expires_at timestamptz,
  p_idempotency_key_hash text, p_request_hash text
) returns table (invitation_id uuid, status text, initiator_owner_id uuid, responder_owner_id uuid,
  expires_at timestamptz, created_at timestamptz, replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare actor public.owners%rowtype; existing companion_private.encounter_invitation_idempotency%rowtype;
  initiator public.social_twins%rowtype; responder public.social_twins%rowtype;
  initiator_persona public.social_personas%rowtype; responder_persona public.social_personas%rowtype;
  new_id uuid:=gen_random_uuid(); issued_at timestamptz:=statement_timestamp();
begin
  select * into actor from public.owners as candidate where candidate.auth_user_id=(select auth.uid()) and candidate.status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.encounter_invitation_idempotency where owner_id=actor.id and idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.action<>'ISSUE' or existing.request_hash<>p_request_hash then raise exception using errcode='23505',message='invitation idempotency key reused with a different request'; end if;
    return query select i.id,i.status,i.initiator_owner_id,i.responder_owner_id,i.expires_at,i.created_at,true from public.encounter_invitations i where i.id=existing.invitation_id; return;
  end if;
  if p_scope<>'ONE_SHOT_ENCOUNTER' or p_purpose is null or char_length(p_purpose) not between 1 and 500
    or p_context_hash!~'^[a-f0-9]{64}$' or p_idempotency_key_hash!~'^[a-f0-9]{64}$' or p_request_hash!~'^[a-f0-9]{64}$'
    or p_expires_at<=issued_at or p_expires_at>issued_at+interval '7 days' then raise exception using errcode='22023',message='invalid Encounter invitation request'; end if;
  select * into initiator from public.social_twins as candidate where candidate.id=p_initiator_twin_id and candidate.owner_id=actor.id and candidate.status='ACTIVE';
  if not found then raise exception using errcode='42501',message='initiator Social Twin is not active for authenticated Owner'; end if;
  select * into responder from public.social_twins as candidate where candidate.id=p_responder_twin_id and candidate.owner_id<>actor.id and candidate.status='ACTIVE';
  if not found then raise exception using errcode='55000',message='responder Social Twin is not active'; end if;
  if exists(select 1 from public.community_blocks b
    join public.community_actors x on x.id=b.actor_id join public.community_actors y on y.id=b.target_id
    where (x.owner_id=actor.id and y.owner_id=responder.owner_id) or (x.owner_id=responder.owner_id and y.owner_id=actor.id)) then
    raise exception using errcode='55000',message='responder Social Twin is not active';
  end if;
  select * into initiator_persona from public.social_personas where id=p_initiator_social_persona_id and id=initiator.active_social_persona_id and companion_id=initiator.companion_id and source_identity_version_id=p_initiator_identity_version_id;
  select * into responder_persona from public.social_personas where id=p_responder_social_persona_id and id=responder.active_social_persona_id and companion_id=responder.companion_id and source_identity_version_id=p_responder_identity_version_id;
  if initiator_persona.id is null or responder_persona.id is null then raise exception using errcode='55000',message='invitation persona or Identity Passport version is stale'; end if;
  insert into public.encounter_invitations(id,initiator_owner_id,initiator_twin_id,responder_owner_id,responder_twin_id,approved_by_owner_ids,purpose,max_uses,expires_at,created_at,status,scope,context_hash,initiator_social_persona_id,initiator_social_persona_version,initiator_identity_version_id,initiator_identity_version,responder_social_persona_id,responder_social_persona_version,responder_identity_version_id,responder_identity_version)
  values(new_id,actor.id,initiator.id,responder.owner_id,responder.id,array[actor.id],p_purpose,1,p_expires_at,issued_at,'PENDING',p_scope,p_context_hash,initiator_persona.id,initiator_persona.version,initiator_persona.source_identity_version_id,initiator_persona.source_identity_version,responder_persona.id,responder_persona.version,responder_persona.source_identity_version_id,responder_persona.source_identity_version);
  insert into companion_private.encounter_invitation_decisions values(new_id,actor.id,initiator.companion_id,initiator.id,'APPROVE',issued_at,p_context_hash);
  insert into companion_private.encounter_invitation_idempotency values(actor.id,p_idempotency_key_hash,p_request_hash,'ISSUE',new_id,issued_at);
  return query select new_id,'PENDING'::text,actor.id,responder.owner_id,p_expires_at,issued_at,false;
end; $$;

commit;
