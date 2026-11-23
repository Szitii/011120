begin;

do $$ declare constraint_name name; begin
  select c.conname into constraint_name from pg_catalog.pg_constraint c
  where c.conrelid='public.encounter_invitations'::regclass and c.contype='c'
    and pg_catalog.pg_get_constraintdef(c.oid) like '%approved_by_owner_ids%';
  if constraint_name is null then raise exception 'mutual approval constraint not found'; end if;
  execute format('alter table public.encounter_invitations drop constraint %I',constraint_name);
end $$;

alter table public.encounter_invitations
  add column status text,
  add column scope text,
  add column context_hash text,
  add column initiator_social_persona_id uuid,
  add column initiator_social_persona_version integer,
  add column initiator_identity_version_id uuid,
  add column initiator_identity_version integer,
  add column responder_social_persona_id uuid,
  add column responder_social_persona_version integer,
  add column responder_identity_version_id uuid,
  add column responder_identity_version integer,
  add column approved_at timestamptz,
  add column rejected_at timestamptz,
  add column rejected_by_owner_id uuid references public.owners(id);

update public.encounter_invitations as invitation
set status = 'APPROVED', scope = 'ONE_SHOT_ENCOUNTER',
    context_hash = encode(sha256(convert_to('legacy-invitation:' || invitation.id::text,'UTF8')), 'hex'),
    initiator_social_persona_id = initiator_twin.active_social_persona_id,
    initiator_social_persona_version = initiator_persona.version,
    initiator_identity_version_id = initiator_persona.source_identity_version_id,
    initiator_identity_version = initiator_persona.source_identity_version,
    responder_social_persona_id = responder_twin.active_social_persona_id,
    responder_social_persona_version = responder_persona.version,
    responder_identity_version_id = responder_persona.source_identity_version_id,
    responder_identity_version = responder_persona.source_identity_version,
    approved_at = invitation.created_at
from public.social_twins as initiator_twin
join public.social_personas as initiator_persona on initiator_persona.id = initiator_twin.active_social_persona_id
join public.social_twins as responder_twin on true
join public.social_personas as responder_persona on responder_persona.id = responder_twin.active_social_persona_id
where initiator_twin.id = invitation.initiator_twin_id
  and responder_twin.id = invitation.responder_twin_id;

alter table public.encounter_invitations
  alter column status set not null,
  alter column scope set not null,
  alter column context_hash set not null,
  alter column initiator_social_persona_id set not null,
  alter column initiator_social_persona_version set not null,
  alter column initiator_identity_version_id set not null,
  alter column initiator_identity_version set not null,
  alter column responder_social_persona_id set not null,
  alter column responder_social_persona_version set not null,
  alter column responder_identity_version_id set not null,
  alter column responder_identity_version set not null,
  add constraint encounter_invitations_status_check check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  add constraint encounter_invitations_scope_check check (scope = 'ONE_SHOT_ENCOUNTER'),
  add constraint encounter_invitations_context_hash_check check (context_hash ~ '^[a-f0-9]{64}$'),
  add constraint encounter_invitations_version_check check (
    initiator_social_persona_version > 0 and initiator_identity_version > 0
    and responder_social_persona_version > 0 and responder_identity_version > 0
  ),
  add constraint encounter_invitations_approval_shape_check check (
    (status = 'PENDING' and approved_by_owner_ids = array[initiator_owner_id] and approved_at is null and rejected_at is null and rejected_by_owner_id is null)
    or (status = 'APPROVED' and approved_by_owner_ids @> array[initiator_owner_id, responder_owner_id] and approved_at is not null and rejected_at is null and rejected_by_owner_id is null)
    or (status = 'REJECTED' and rejected_at is not null and rejected_by_owner_id in (initiator_owner_id, responder_owner_id) and approved_at is null)
  );

create table companion_private.encounter_invitation_idempotency (
  owner_id uuid not null references public.owners(id) on delete cascade,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('ISSUE', 'APPROVE', 'REJECT')),
  invitation_id uuid not null references public.encounter_invitations(id),
  created_at timestamptz not null default now(),
  primary key (owner_id, idempotency_key_hash)
);

create table companion_private.encounter_invitation_decisions (
  invitation_id uuid not null references public.encounter_invitations(id),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  social_twin_id uuid not null,
  decision text not null check (decision in ('APPROVE', 'REJECT')),
  decided_at timestamptz not null,
  context_hash text not null check (context_hash ~ '^[a-f0-9]{64}$'),
  primary key (invitation_id, owner_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  foreign key (social_twin_id, owner_id) references public.social_twins(id, owner_id)
);

-- Migration/test seed compatibility only: direct table writes remain revoked from runtime roles.
create or replace function companion_private.complete_legacy_invitation_seed()
returns trigger language plpgsql set search_path='' as $$
declare it public.social_twins%rowtype; rt public.social_twins%rowtype; ip public.social_personas%rowtype; rp public.social_personas%rowtype;
begin
  if new.status is not null then return new; end if;
  if not new.approved_by_owner_ids @> array[new.initiator_owner_id,new.responder_owner_id] then
    raise exception using errcode='23514',message='direct invitation seed requires mutual consent evidence';
  end if;
  select * into it from public.social_twins where id=new.initiator_twin_id and owner_id=new.initiator_owner_id;
  select * into rt from public.social_twins where id=new.responder_twin_id and owner_id=new.responder_owner_id;
  select * into ip from public.social_personas where id=it.active_social_persona_id;
  select * into rp from public.social_personas where id=rt.active_social_persona_id;
  if ip.id is null or rp.id is null then raise exception using errcode='55000',message='direct invitation seed has invalid Social Twin binding'; end if;
  new.status:='APPROVED';new.scope:='ONE_SHOT_ENCOUNTER';new.context_hash:=pg_catalog.encode(sha256(convert_to('controlled-seed:'||new.id::text,'UTF8')),'hex');
  new.initiator_social_persona_id:=ip.id;new.initiator_social_persona_version:=ip.version;new.initiator_identity_version_id:=ip.source_identity_version_id;new.initiator_identity_version:=ip.source_identity_version;
  new.responder_social_persona_id:=rp.id;new.responder_social_persona_version:=rp.version;new.responder_identity_version_id:=rp.source_identity_version_id;new.responder_identity_version:=rp.source_identity_version;new.approved_at:=coalesce(new.created_at,statement_timestamp());
  return new;
end; $$;
create trigger encounter_invitation_controlled_seed before insert on public.encounter_invitations
for each row execute function companion_private.complete_legacy_invitation_seed();

create trigger encounter_invitation_idempotency_immutable before update or delete
on companion_private.encounter_invitation_idempotency for each row
execute function companion_private.reject_immutable_mutation();
create trigger encounter_invitation_decisions_immutable before update or delete
on companion_private.encounter_invitation_decisions for each row
execute function companion_private.reject_immutable_mutation();

revoke all on table companion_private.encounter_invitation_idempotency,
  companion_private.encounter_invitation_decisions from public, anon, authenticated;

create or replace function companion_private.allow_invitation_claim_then_consume()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Encounter invitations are append-only capabilities';
  end if;
  if old.status = 'PENDING' and new.status = 'APPROVED'
    and old.claimed_at is null and old.used_at is null
    and new.approved_by_owner_ids = array[old.initiator_owner_id, old.responder_owner_id]
    and new.approved_at = statement_timestamp()
    and (to_jsonb(new) - array['status','approved_by_owner_ids','approved_at'])
      = (to_jsonb(old) - array['status','approved_by_owner_ids','approved_at']) then return new;
  end if;
  if old.status = 'PENDING' and new.status = 'REJECTED'
    and old.claimed_at is null and old.used_at is null
    and new.rejected_at = statement_timestamp()
    and new.rejected_by_owner_id in (old.initiator_owner_id, old.responder_owner_id)
    and (to_jsonb(new) - array['status','rejected_at','rejected_by_owner_id'])
      = (to_jsonb(old) - array['status','rejected_at','rejected_by_owner_id']) then return new;
  end if;
  if old.status = 'APPROVED' and old.claimed_at is null and old.used_at is null
    and new.claimed_at = statement_timestamp() and new.claimed_at < old.expires_at
    and exists(select 1 from public.social_twins t join public.social_personas p on p.id=t.active_social_persona_id
      where t.id=old.initiator_twin_id and t.owner_id=old.initiator_owner_id and t.status='ACTIVE'
        and p.id=old.initiator_social_persona_id and p.version=old.initiator_social_persona_version
        and p.source_identity_version_id=old.initiator_identity_version_id and p.source_identity_version=old.initiator_identity_version)
    and exists(select 1 from public.social_twins t join public.social_personas p on p.id=t.active_social_persona_id
      where t.id=old.responder_twin_id and t.owner_id=old.responder_owner_id and t.status='ACTIVE'
        and p.id=old.responder_social_persona_id and p.version=old.responder_social_persona_version
        and p.source_identity_version_id=old.responder_identity_version_id and p.source_identity_version=old.responder_identity_version)
    and new.used_at is null and (to_jsonb(new)-array['claimed_at','used_at'])=(to_jsonb(old)-array['claimed_at','used_at']) then return new;
  end if;
  if old.claimed_at is not null and old.used_at is null and new.claimed_at = old.claimed_at
    and new.used_at is not null and new.used_at >= old.claimed_at
    and (to_jsonb(new)-array['claimed_at','used_at'])=(to_jsonb(old)-array['claimed_at','used_at']) then return new;
  end if;
  raise exception using errcode = '55000', message = 'Encounter invitations may only be claimed once and consumed once';
end; $$;

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
  select * into initiator_persona from public.social_personas where id=p_initiator_social_persona_id and id=initiator.active_social_persona_id and companion_id=initiator.companion_id and source_identity_version_id=p_initiator_identity_version_id;
  select * into responder_persona from public.social_personas where id=p_responder_social_persona_id and id=responder.active_social_persona_id and companion_id=responder.companion_id and source_identity_version_id=p_responder_identity_version_id;
  if initiator_persona.id is null or responder_persona.id is null then raise exception using errcode='55000',message='invitation persona or Identity Passport version is stale'; end if;
  insert into public.encounter_invitations(id,initiator_owner_id,initiator_twin_id,responder_owner_id,responder_twin_id,approved_by_owner_ids,purpose,max_uses,expires_at,created_at,status,scope,context_hash,initiator_social_persona_id,initiator_social_persona_version,initiator_identity_version_id,initiator_identity_version,responder_social_persona_id,responder_social_persona_version,responder_identity_version_id,responder_identity_version)
  values(new_id,actor.id,initiator.id,responder.owner_id,responder.id,array[actor.id],p_purpose,1,p_expires_at,issued_at,'PENDING',p_scope,p_context_hash,initiator_persona.id,initiator_persona.version,initiator_persona.source_identity_version_id,initiator_persona.source_identity_version,responder_persona.id,responder_persona.version,responder_persona.source_identity_version_id,responder_persona.source_identity_version);
  insert into companion_private.encounter_invitation_decisions values(new_id,actor.id,initiator.companion_id,initiator.id,'APPROVE',issued_at,p_context_hash);
  insert into companion_private.encounter_invitation_idempotency values(actor.id,p_idempotency_key_hash,p_request_hash,'ISSUE',new_id,issued_at);
  return query select new_id,'PENDING'::text,actor.id,responder.owner_id,p_expires_at,issued_at,false;
end; $$;

create or replace function companion_private.decide_encounter_invitation(p_invitation_id uuid,p_decision text,p_idempotency_key_hash text,p_request_hash text)
returns table(invitation_id uuid,status text,decided_at timestamptz,replayed boolean)
language plpgsql security definer set search_path='' as $$
declare actor public.owners%rowtype; invitation public.encounter_invitations%rowtype; twin public.social_twins%rowtype;
  existing companion_private.encounter_invitation_idempotency%rowtype; decision_time timestamptz:=statement_timestamp(); action_name text;
begin
  action_name:=case p_decision when 'APPROVE' then 'APPROVE' when 'REJECT' then 'REJECT' else null end;
  select * into actor from public.owners as candidate where candidate.auth_user_id=(select auth.uid()) and candidate.status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.encounter_invitation_idempotency where owner_id=actor.id and idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.action<>action_name or existing.request_hash<>p_request_hash or existing.invitation_id<>p_invitation_id then raise exception using errcode='23505',message='invitation decision idempotency key reused with a different request'; end if;
    select * into invitation from public.encounter_invitations where id=p_invitation_id;
    return query select invitation.id,invitation.status,existing.created_at,true; return;
  end if;
  if action_name is null or p_idempotency_key_hash!~'^[a-f0-9]{64}$' or p_request_hash!~'^[a-f0-9]{64}$' then raise exception using errcode='22023',message='invalid invitation decision'; end if;
  select * into invitation from public.encounter_invitations where id=p_invitation_id and actor.id in(initiator_owner_id,responder_owner_id) for update;
  if not found then raise exception using errcode='P0001',message='invitation not found for authenticated Owner'; end if;
  if invitation.status<>'PENDING' or invitation.claimed_at is not null or invitation.used_at is not null then raise exception using errcode='55000',message='invitation no longer accepts decisions'; end if;
  if decision_time>=invitation.expires_at then raise exception using errcode='55000',message='expired invitation cannot be decided'; end if;
  if actor.id=invitation.initiator_owner_id then raise exception using errcode='55000',message='issuer approval was fixed at issuance'; end if;
  select * into twin from public.social_twins as candidate where candidate.id=invitation.responder_twin_id and candidate.owner_id=actor.id and candidate.status='ACTIVE' and candidate.active_social_persona_id=invitation.responder_social_persona_id;
  if not found then raise exception using errcode='55000',message='responder Social Twin or approved persona version is no longer active'; end if;
  insert into companion_private.encounter_invitation_decisions values(invitation.id,actor.id,twin.companion_id,twin.id,p_decision,decision_time,invitation.context_hash);
  if p_decision='APPROVE' then update public.encounter_invitations set status='APPROVED',approved_by_owner_ids=array[initiator_owner_id,responder_owner_id],approved_at=decision_time where id=invitation.id;
  else update public.encounter_invitations set status='REJECTED',rejected_at=decision_time,rejected_by_owner_id=actor.id where id=invitation.id; end if;
  insert into companion_private.encounter_invitation_idempotency values(actor.id,p_idempotency_key_hash,p_request_hash,action_name,invitation.id,decision_time);
  return query select invitation.id,case when p_decision='APPROVE' then 'APPROVED' else 'REJECTED' end,decision_time,false;
end; $$;

create or replace function public.approve_encounter_invitation(uuid,text,text) returns table(invitation_id uuid,status text,decided_at timestamptz,replayed boolean)
language sql security definer set search_path='' as $$ select * from companion_private.decide_encounter_invitation($1,'APPROVE',$2,$3) $$;
create or replace function public.reject_encounter_invitation(uuid,text,text) returns table(invitation_id uuid,status text,decided_at timestamptz,replayed boolean)
language sql security definer set search_path='' as $$ select * from companion_private.decide_encounter_invitation($1,'REJECT',$2,$3) $$;

create or replace function public.list_encounter_invitations(p_limit integer,p_before_created_at timestamptz,p_before_id uuid)
returns table(invitation_id uuid,status text,role text,initiator_owner_id uuid,initiator_twin_id uuid,responder_owner_id uuid,responder_twin_id uuid,purpose text,scope text,context_hash text,expires_at timestamptz,claimed_at timestamptz,used_at timestamptz,created_at timestamptz)
language sql stable security invoker set search_path='' as $$
 select i.id,case when i.status in('PENDING','APPROVED') and i.expires_at<=statement_timestamp() then 'EXPIRED' else i.status end,
 case when o.id=i.initiator_owner_id then 'INITIATOR' else 'RESPONDER' end,i.initiator_owner_id,i.initiator_twin_id,i.responder_owner_id,i.responder_twin_id,i.purpose,i.scope,i.context_hash,i.expires_at,i.claimed_at,i.used_at,i.created_at
 from public.encounter_invitations i join public.owners o on o.id in(i.initiator_owner_id,i.responder_owner_id)
 where p_limit between 1 and 100 and (p_before_created_at is null or (i.created_at,i.id)<(p_before_created_at,p_before_id)) order by i.created_at desc,i.id desc limit p_limit
$$;

revoke all on function public.issue_encounter_invitation(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text,text), public.approve_encounter_invitation(uuid,text,text), public.reject_encounter_invitation(uuid,text,text), public.list_encounter_invitations(integer,timestamptz,uuid) from public,anon;
grant execute on function public.issue_encounter_invitation(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text,text), public.approve_encounter_invitation(uuid,text,text), public.reject_encounter_invitation(uuid,text,text), public.list_encounter_invitations(integer,timestamptz,uuid) to authenticated;

comment on table companion_private.encounter_invitation_decisions is 'Immutable Owner-authenticated consent evidence with no message or private-memory body.';
comment on table public.encounter_invitations is 'Owner-authenticated, version-frozen, expiring one-shot Encounter capabilities from pending consent through consumption.';
comment on function public.issue_encounter_invitation(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text,text) is 'Issues a one-shot invitation and records the authenticated initiating Owner approval.';

commit;
