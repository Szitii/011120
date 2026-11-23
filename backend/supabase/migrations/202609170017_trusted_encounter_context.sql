begin;

create table companion_private.encounter_context_snapshots (
  id uuid primary key default gen_random_uuid(),
  execution_claim_id uuid not null unique references companion_private.encounter_execution_claims(id),
  actor_owner_id uuid not null references public.owners(id),
  encounter_id uuid not null unique,
  invitation_id uuid not null references public.encounter_invitations(id),
  generation_transaction_id uuid not null unique references public.compute_transactions(id),
  initiator_owner_id uuid not null,
  initiator_twin_id uuid not null,
  initiator_social_persona_id uuid not null,
  initiator_social_persona_version integer not null,
  initiator_identity_version_id uuid not null,
  initiator_identity_version integer not null,
  responder_owner_id uuid not null,
  responder_companion_id uuid not null,
  responder_twin_id uuid not null,
  responder_social_persona_id uuid not null,
  responder_social_persona_version integer not null,
  responder_identity_version_id uuid not null,
  responder_identity_version integer not null,
  scope text not null check (scope = 'ONE_SHOT_ENCOUNTER'),
  purpose text not null,
  invitation_context_hash text not null check (invitation_context_hash ~ '^[a-f0-9]{64}$'),
  invitation_expires_at timestamptz not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  provider_request_hash text not null check (provider_request_hash ~ '^[a-f0-9]{64}$'),
  responder_persona jsonb not null check (jsonb_typeof(responder_persona) = 'object'),
  authorized_memories jsonb not null check (jsonb_typeof(authorized_memories) = 'array'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default statement_timestamp(),
  unique (actor_owner_id, idempotency_key_hash)
);

create trigger encounter_context_snapshots_immutable before update or delete
on companion_private.encounter_context_snapshots for each row
execute function companion_private.reject_immutable_mutation();

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
  select * into i from public.encounter_invitations where id=p_invitation_id and initiator_owner_id=p_actor_owner_id;
  if not found then raise exception using errcode='P0001',message='Encounter invitation not found for initiating Owner'; end if;
  if i.status<>'APPROVED' or i.claimed_at is not null or i.used_at is not null or i.expires_at<=statement_timestamp()
    or not i.approved_by_owner_ids @> array[i.initiator_owner_id,i.responder_owner_id] then
    raise exception using errcode='55000',message='Encounter invitation is not approved and claimable';
  end if;
  select * into it from public.social_twins where id=i.initiator_twin_id and owner_id=i.initiator_owner_id and status='ACTIVE';
  select * into rt from public.social_twins where id=i.responder_twin_id and owner_id=i.responder_owner_id and status='ACTIVE';
  if it.id is null or rt.id is null then raise exception using errcode='55000',message='Encounter Social Twin is inactive'; end if;
  if not exists(select 1 from public.social_personas p where p.id=i.initiator_social_persona_id and p.id=it.active_social_persona_id and p.version=i.initiator_social_persona_version and p.source_identity_version_id=i.initiator_identity_version_id and p.source_identity_version=i.initiator_identity_version)
    or not exists(select 1 from public.social_personas p where p.id=i.responder_social_persona_id and p.id=rt.active_social_persona_id and p.version=i.responder_social_persona_version and p.source_identity_version_id=i.responder_identity_version_id and p.source_identity_version=i.responder_identity_version) then
    raise exception using errcode='55000',message='Encounter frozen identity version is no longer active';
  end if;
  return query select i.initiator_owner_id,i.initiator_twin_id,i.responder_owner_id,rt.companion_id,i.responder_twin_id,i.responder_social_persona_version,i.responder_identity_version;
end $$;

create or replace function companion_private.assemble_encounter_context(
  p_actor_owner_id uuid, p_execution_claim_id uuid, p_idempotency_key_hash text,
  p_request_hash text, p_provider_request_hash text, p_max_memories integer
) returns table(
  snapshot_id uuid, encounter_id uuid, generation_transaction_id uuid,
  initiator_twin_id uuid, responder_owner_id uuid, responder_companion_id uuid,
  responder_twin_id uuid, responder_social_persona_version integer,
  responder_identity_version integer, responder_persona jsonb,
  authorized_memories jsonb, manifest jsonb, manifest_hash text, replayed boolean
)
language plpgsql security definer set search_path='' as $$
declare
  existing companion_private.encounter_context_snapshots%rowtype;
  c companion_private.encounter_execution_claims%rowtype;
  i public.encounter_invitations%rowtype; it public.social_twins%rowtype; rt public.social_twins%rowtype;
  ip public.social_personas%rowtype; rp public.social_personas%rowtype; tx public.compute_transactions%rowtype;
  memories jsonb; persona jsonb; manifest_value jsonb; manifest_digest text; snapshot uuid:=gen_random_uuid();
begin
  if p_idempotency_key_hash!~'^[a-f0-9]{64}$' or p_request_hash!~'^[a-f0-9]{64}$'
    or p_provider_request_hash!~'^[a-f0-9]{64}$' or p_max_memories not between 0 and 20 then
    raise exception using errcode='22023',message='invalid Encounter context assembly request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor_owner_id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.encounter_context_snapshots where actor_owner_id=p_actor_owner_id and idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.execution_claim_id<>p_execution_claim_id or existing.request_hash<>p_request_hash or existing.provider_request_hash<>p_provider_request_hash then
      raise exception using errcode='23505',message='Encounter context idempotency key reused with a different request';
    end if;
    return query select existing.id,existing.encounter_id,existing.generation_transaction_id,existing.initiator_twin_id,existing.responder_owner_id,existing.responder_companion_id,existing.responder_twin_id,existing.responder_social_persona_version,existing.responder_identity_version,existing.responder_persona,existing.authorized_memories,existing.manifest,existing.manifest_hash,true;
    return;
  end if;
  select * into c from companion_private.encounter_execution_claims where id=p_execution_claim_id and actor_owner_id=p_actor_owner_id for update;
  if not found then raise exception using errcode='P0001',message='Encounter execution claim not found for Owner'; end if;
  select * into i from public.encounter_invitations where id=c.invitation_id for update;
  if i.status<>'APPROVED' or i.claimed_at is distinct from c.claimed_at or i.used_at is not null or i.expires_at<=statement_timestamp()
    then raise exception using errcode='55000',message='Encounter claim is not eligible for context assembly'; end if;
  if not i.approved_by_owner_ids @> array[i.initiator_owner_id,i.responder_owner_id] then raise exception using errcode='42501',message='mutual Owner approval is required'; end if;
  select * into it from public.social_twins where id=i.initiator_twin_id and owner_id=i.initiator_owner_id and status='ACTIVE' for share;
  select * into rt from public.social_twins where id=i.responder_twin_id and owner_id=i.responder_owner_id and status='ACTIVE' for share;
  if it.id is null or rt.id is null then raise exception using errcode='55000',message='Encounter Social Twin is inactive'; end if;
  select * into ip from public.social_personas where id=i.initiator_social_persona_id and id=it.active_social_persona_id and version=i.initiator_social_persona_version and source_identity_version_id=i.initiator_identity_version_id and source_identity_version=i.initiator_identity_version;
  select * into rp from public.social_personas where id=i.responder_social_persona_id and id=rt.active_social_persona_id and version=i.responder_social_persona_version and source_identity_version_id=i.responder_identity_version_id and source_identity_version=i.responder_identity_version;
  if ip.id is null or rp.id is null then raise exception using errcode='55000',message='Encounter frozen Persona or Identity Passport version mismatch'; end if;
  select * into tx from public.compute_transactions where id=c.generation_transaction_id and owner_id=rt.owner_id and companion_id=rt.companion_id and social_twin_id=rt.id and trigger_event_id=c.encounter_id and reason_code='SOCIAL_ENCOUNTER_RESPONSE' for share;
  if not found or tx.identity_version<>i.responder_identity_version or tx.social_persona_version<>i.responder_social_persona_version then raise exception using errcode='55000',message='Compute transaction is outside frozen Encounter context'; end if;

  -- Descriptor and permission predicates materialize before the representation join reads summaries.
  with authorized_descriptors as materialized (
    select m.id,m.source_trust,
      case when m.domain in ('SOCIAL','PUBLIC') then 'SUMMARY'
           else coalesce((select min(case p.max_disclosure when 'PRESENCE_ONLY' then '0' when 'SUMMARY' then '1' else '2' end) from companion_private.memory_permissions p where p.memory_id=m.id and p.owner_id=m.owner_id and p.effect='ALLOW' and p.grantee_type='SOCIAL_TWIN' and p.grantee_id=rt.id and p.purpose='SOCIAL_ENCOUNTER' and (p.expires_at is null or p.expires_at>statement_timestamp())),'0') end disclosure_rank
    from companion_private.memory_records m
    where m.owner_id=rt.owner_id and m.companion_id=rt.companion_id and m.namespace='SOCIAL'
      and m.domain in ('FRIEND_SHAREABLE','SOCIAL','PUBLIC') and m.revoked_at is null
      and (m.valid_until is null or m.valid_until>statement_timestamp())
      and not exists(select 1 from companion_private.memory_permissions d where d.memory_id=m.id and d.owner_id=m.owner_id and d.effect='DENY' and d.grantee_type='SOCIAL_TWIN' and d.grantee_id=rt.id and d.purpose='SOCIAL_ENCOUNTER' and (d.expires_at is null or d.expires_at>statement_timestamp()))
      and (m.domain in ('SOCIAL','PUBLIC') or exists(select 1 from companion_private.memory_permissions a where a.memory_id=m.id and a.owner_id=m.owner_id and a.effect='ALLOW' and a.grantee_type='SOCIAL_TWIN' and a.grantee_id=rt.id and a.purpose='SOCIAL_ENCOUNTER' and (a.expires_at is null or a.expires_at>statement_timestamp())))
    order by m.id limit p_max_memories
  ), representations as (
    select d.id,d.source_trust,d.disclosure_rank,m.summary
    from authorized_descriptors d join companion_private.memory_records m on m.id=d.id
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'representation',case disclosure_rank when '0' then '[memory present]' else summary end,'disclosure',case disclosure_rank when '0' then 'PRESENCE_ONLY' else 'SUMMARY' end,'sourceTrust',source_trust) order by id),'[]'::jsonb) into memories from representations;
  persona:=jsonb_build_object('socialTwinId',rt.id,'socialPersonaId',rp.id,'socialPersonaVersion',rp.version,'handle',rp.handle,'displayName',rp.display_name,'publicDocument',rp.public_document);
  manifest_value:=jsonb_build_object('encounterId',c.encounter_id,'executionClaimId',c.id,'invitationId',i.id,'generationTransactionId',c.generation_transaction_id,'initiatorOwnerId',i.initiator_owner_id,'initiatorTwinId',i.initiator_twin_id,'initiatorSocialPersonaId',i.initiator_social_persona_id,'initiatorSocialPersonaVersion',i.initiator_social_persona_version,'initiatorIdentityVersionId',i.initiator_identity_version_id,'initiatorIdentityVersion',i.initiator_identity_version,'responderOwnerId',i.responder_owner_id,'responderTwinId',i.responder_twin_id,'responderSocialPersonaId',i.responder_social_persona_id,'responderSocialPersonaVersion',i.responder_social_persona_version,'responderIdentityVersionId',i.responder_identity_version_id,'responderIdentityVersion',i.responder_identity_version,'scope',i.scope,'purpose',i.purpose,'contextHash',i.context_hash,'expiresAt',i.expires_at,'providerRequestHash',p_provider_request_hash,'memoryIds',(select coalesce(jsonb_agg(value->>'id' order by value->>'id'),'[]'::jsonb) from jsonb_array_elements(memories)));
  manifest_digest:=encode(sha256(convert_to(manifest_value::text,'UTF8')),'hex');
  insert into companion_private.encounter_context_snapshots(
    id,execution_claim_id,actor_owner_id,encounter_id,invitation_id,generation_transaction_id,
    initiator_owner_id,initiator_twin_id,initiator_social_persona_id,initiator_social_persona_version,
    initiator_identity_version_id,initiator_identity_version,responder_owner_id,responder_companion_id,
    responder_twin_id,responder_social_persona_id,responder_social_persona_version,
    responder_identity_version_id,responder_identity_version,scope,purpose,invitation_context_hash,
    invitation_expires_at,idempotency_key_hash,request_hash,provider_request_hash,responder_persona,
    authorized_memories,manifest,manifest_hash,created_at
  ) values(snapshot,c.id,p_actor_owner_id,c.encounter_id,i.id,c.generation_transaction_id,
    i.initiator_owner_id,i.initiator_twin_id,i.initiator_social_persona_id,i.initiator_social_persona_version,
    i.initiator_identity_version_id,i.initiator_identity_version,i.responder_owner_id,rt.companion_id,
    i.responder_twin_id,i.responder_social_persona_id,i.responder_social_persona_version,
    i.responder_identity_version_id,i.responder_identity_version,i.scope,i.purpose,i.context_hash,
    i.expires_at,p_idempotency_key_hash,p_request_hash,p_provider_request_hash,persona,memories,
    manifest_value,manifest_digest,statement_timestamp());
  return query select snapshot,c.encounter_id,c.generation_transaction_id,i.initiator_twin_id,i.responder_owner_id,rt.companion_id,i.responder_twin_id,i.responder_social_persona_version,i.responder_identity_version,persona,memories,manifest_value,manifest_digest,false;
end $$;

revoke all on table companion_private.encounter_context_snapshots from public,anon,authenticated;
revoke all on function companion_private.get_encounter_preparation(uuid,uuid) from public,anon,authenticated;
revoke all on function companion_private.assemble_encounter_context(uuid,uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function companion_private.get_encounter_preparation(uuid,uuid) to service_role;
grant execute on function companion_private.assemble_encounter_context(uuid,uuid,text,text,text,integer) to service_role;
comment on table companion_private.encounter_context_snapshots is 'Immutable claim-bound server context; contains only public Persona projection and permission-filtered minimal social Memory representations.';
comment on function companion_private.assemble_encounter_context(uuid,uuid,text,text,text,integer) is 'Locks and validates the approved claim and frozen identities before permission-first Memory selection and deterministic snapshot creation.';

commit;
