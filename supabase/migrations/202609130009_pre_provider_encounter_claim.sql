begin;

alter table public.encounter_invitations
  add column claimed_at timestamptz;

drop trigger encounter_invitations_consume_only on public.encounter_invitations;

-- Preserve already-consumed rows when upgrading an existing database.
update public.encounter_invitations
set claimed_at = used_at
where used_at is not null;

alter table public.encounter_invitations
  add constraint encounter_invitations_use_requires_claim
    check (used_at is null or claimed_at is not null);

create or replace function companion_private.allow_invitation_claim_then_consume()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Encounter invitations are append-only capabilities';
  end if;

  if old.claimed_at is null
    and old.used_at is null
    and new.claimed_at is not null
    and new.claimed_at = statement_timestamp()
    and new.claimed_at >= old.created_at
    and new.claimed_at < old.expires_at
    and new.used_at is null
    and (to_jsonb(new) - array['claimed_at', 'used_at'])
      = (to_jsonb(old) - array['claimed_at', 'used_at']) then
    return new;
  end if;

  if old.claimed_at is not null
    and old.used_at is null
    and new.claimed_at = old.claimed_at
    and new.used_at is not null
    and new.used_at >= old.claimed_at
    and (to_jsonb(new) - array['claimed_at', 'used_at'])
      = (to_jsonb(old) - array['claimed_at', 'used_at']) then
    return new;
  end if;

  raise exception using errcode = '55000',
    message = 'Encounter invitations may only be claimed once and consumed once';
end;
$$;

create trigger encounter_invitations_claim_then_consume
before update or delete on public.encounter_invitations
for each row execute function companion_private.allow_invitation_claim_then_consume();

create table companion_private.encounter_execution_claims (
  id uuid primary key default gen_random_uuid(),
  actor_owner_id uuid not null references public.owners(id) on delete cascade,
  encounter_id uuid not null unique,
  invitation_id uuid not null unique references public.encounter_invitations(id),
  generation_transaction_id uuid not null unique references public.compute_transactions(id),
  publication_reservation_id uuid not null unique references public.publication_reservations(id),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (actor_owner_id, idempotency_key_hash)
);

create trigger encounter_execution_claims_immutable
before update or delete on companion_private.encounter_execution_claims
for each row execute function companion_private.reject_immutable_mutation();

create or replace function companion_private.require_claim_before_encounter_start()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  compute_transaction public.compute_transactions%rowtype;
begin
  if new.entry_type <> 'START' or new.status <> 'STARTED' then
    return new;
  end if;

  select * into compute_transaction
  from public.compute_transactions
  where id = new.transaction_id;

  if compute_transaction.reason_code = 'SOCIAL_ENCOUNTER_RESPONSE'
    and not exists (
      select 1
      from companion_private.encounter_execution_claims as claim
      where claim.generation_transaction_id = new.transaction_id
        and claim.encounter_id = compute_transaction.trigger_event_id
        and claim.claimed_at <= new.created_at
    ) then
    raise exception using errcode = '55000',
      message = 'social Encounter provider start requires a durable execution claim';
  end if;

  return new;
end;
$$;

create trigger compute_start_requires_encounter_claim
before insert on public.compute_ledger_entries
for each row execute function companion_private.require_claim_before_encounter_start();

alter table companion_private.encounter_idempotency
  add column execution_claim_id uuid
    references companion_private.encounter_execution_claims(id);

create or replace function companion_private.claim_encounter_execution(
  p_actor_owner_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_encounter_id uuid,
  p_invitation_id uuid,
  p_generation_transaction_id uuid,
  p_publication_reservation_id uuid
)
returns table (
  execution_claim_id uuid,
  encounter_id uuid,
  invitation_id uuid,
  claimed_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_claim companion_private.encounter_execution_claims%rowtype;
  invitation public.encounter_invitations%rowtype;
  initiator_twin public.social_twins%rowtype;
  responder_twin public.social_twins%rowtype;
  compute_transaction public.compute_transactions%rowtype;
  compute_reservation public.compute_ledger_entries%rowtype;
  publication_reservation public.publication_reservations%rowtype;
  new_claim_id uuid := gen_random_uuid();
  claim_time timestamptz := statement_timestamp();
begin
  if p_actor_owner_id is null
    or p_encounter_id is null
    or p_invitation_id is null
    or p_generation_transaction_id is null
    or p_publication_reservation_id is null
    or p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid Encounter execution claim';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_actor_owner_id::text || ':' || p_idempotency_key_hash, 0)
  );

  select * into existing_claim
  from companion_private.encounter_execution_claims as candidate
  where candidate.actor_owner_id = p_actor_owner_id
    and candidate.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    if existing_claim.request_hash <> p_request_hash
      or existing_claim.encounter_id <> p_encounter_id
      or existing_claim.invitation_id <> p_invitation_id
      or existing_claim.generation_transaction_id <> p_generation_transaction_id
      or existing_claim.publication_reservation_id <> p_publication_reservation_id then
      raise exception using errcode = '23505',
        message = 'Encounter execution claim idempotency key reused with a different request';
    end if;
    return query select existing_claim.id, existing_claim.encounter_id,
      existing_claim.invitation_id, existing_claim.claimed_at, true;
    return;
  end if;

  select * into invitation
  from public.encounter_invitations as candidate
  where candidate.id = p_invitation_id
    and candidate.initiator_owner_id = p_actor_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'Encounter invitation not found for initiating Owner';
  end if;
  if invitation.claimed_at is not null or invitation.used_at is not null or invitation.max_uses <> 1 then
    raise exception using errcode = '55000', message = 'Encounter invitation is already claimed or consumed';
  end if;
  if claim_time < invitation.created_at or claim_time >= invitation.expires_at then
    raise exception using errcode = '55000', message = 'Encounter invitation cannot be claimed outside its validity window';
  end if;
  if not invitation.approved_by_owner_ids @> array[invitation.initiator_owner_id, invitation.responder_owner_id] then
    raise exception using errcode = '42501', message = 'mutual Owner approval is required';
  end if;

  select * into initiator_twin
  from public.social_twins
  where id = invitation.initiator_twin_id
    and owner_id = invitation.initiator_owner_id
    and status = 'ACTIVE';
  if not found then
    raise exception using errcode = '55000', message = 'initiator Social Twin is not active';
  end if;

  select * into responder_twin
  from public.social_twins
  where id = invitation.responder_twin_id
    and owner_id = invitation.responder_owner_id
    and status = 'ACTIVE';
  if not found then
    raise exception using errcode = '55000', message = 'responder Social Twin is not active';
  end if;

  select * into compute_transaction
  from public.compute_transactions as candidate
  where candidate.id = p_generation_transaction_id
    and candidate.owner_id = invitation.responder_owner_id
    and candidate.companion_id = responder_twin.companion_id
    and candidate.social_twin_id = invitation.responder_twin_id
    and candidate.reason_code = 'SOCIAL_ENCOUNTER_RESPONSE'
    and candidate.trigger_event_type = 'ENCOUNTER'
    and candidate.trigger_event_id = p_encounter_id;
  if not found then
    raise exception using errcode = '55000', message = 'generation transaction is outside the approved Encounter scope';
  end if;

  select * into compute_reservation
  from public.compute_ledger_entries as entry
  where entry.transaction_id = p_generation_transaction_id
  order by entry.sequence desc
  limit 1
  for update;
  if not found
    or compute_reservation.entry_type <> 'RESERVATION'
    or compute_reservation.status <> 'RESERVED'
    or compute_reservation.created_at < invitation.created_at
    or compute_reservation.created_at > claim_time then
    raise exception using errcode = '55000',
      message = 'Encounter execution requires an in-window Compute reservation not sent to a provider';
  end if;

  select * into publication_reservation
  from public.publication_reservations as candidate
  where candidate.id = p_publication_reservation_id
    and candidate.owner_id = invitation.responder_owner_id
    and candidate.companion_id = responder_twin.companion_id
    and candidate.related_event_id = p_encounter_id
  for update;
  if not found
    or publication_reservation.status <> 'RESERVED'
    or publication_reservation.created_at < invitation.created_at
    or publication_reservation.created_at > claim_time then
    raise exception using errcode = '55000',
      message = 'Encounter execution requires an in-window publication reservation';
  end if;

  update public.encounter_invitations
  set claimed_at = claim_time
  where id = invitation.id;

  insert into companion_private.encounter_execution_claims (
    id, actor_owner_id, encounter_id, invitation_id, generation_transaction_id,
    publication_reservation_id, idempotency_key_hash, request_hash, claimed_at
  ) values (
    new_claim_id, p_actor_owner_id, p_encounter_id, invitation.id,
    compute_transaction.id, publication_reservation.id,
    p_idempotency_key_hash, p_request_hash, claim_time
  );

  return query select new_claim_id, p_encounter_id, invitation.id, claim_time, false;
end;
$$;

create or replace function companion_private.bind_terminal_encounter_to_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  matching_claim companion_private.encounter_execution_claims%rowtype;
  artifact public.encounter_artifacts%rowtype;
begin
  if new.execution_claim_id is not null then
    raise exception using errcode = '22023', message = 'Encounter execution claim is database-derived';
  end if;

  if new.artifact_id is not null then
    if new.result_status not in ('DELIVERED', 'REDACTED') then
      raise exception using errcode = '55000', message = 'only delivered Encounter results may reference an Artifact';
    end if;
    select * into artifact
    from public.encounter_artifacts
    where id = new.artifact_id;
    select * into matching_claim
    from companion_private.encounter_execution_claims as claim
    where claim.actor_owner_id = new.owner_id
      and claim.encounter_id = new.encounter_id
      and claim.invitation_id = artifact.invitation_id
      and claim.generation_transaction_id = artifact.generation_transaction_id
      and claim.publication_reservation_id = new.publication_reservation_id;
  elsif new.generation_transaction_id is not null then
    if new.result_status not in ('BLOCKED', 'FAILED') then
      raise exception using errcode = '55000', message = 'non-delivery claim binding requires a blocked or failed result';
    end if;
    select * into matching_claim
    from companion_private.encounter_execution_claims as claim
    where claim.actor_owner_id = new.owner_id
      and claim.encounter_id = new.encounter_id
      and claim.invitation_id = new.invitation_id
      and claim.generation_transaction_id = new.generation_transaction_id
      and claim.publication_reservation_id = new.publication_reservation_id;
  elsif new.result_status = 'BLOCKED'
    and new.invitation_id is not null
    and new.safety_event_id is not null
    and new.publication_reservation_id is null then
    return new;
  else
    raise exception using errcode = '55000',
      message = 'terminal Encounter result lacks a valid pre-provider execution claim';
  end if;

  if not found or not exists (
    select 1
    from public.compute_ledger_entries as entry
    where entry.transaction_id = matching_claim.generation_transaction_id
      and entry.entry_type = 'START'
      and entry.status = 'STARTED'
      and entry.created_at >= matching_claim.claimed_at
  ) then
    raise exception using errcode = '55000',
      message = 'terminal Encounter result is not bound to a claimed provider start';
  end if;

  new.execution_claim_id := matching_claim.id;
  return new;
end;
$$;

create trigger encounter_terminal_requires_execution_claim
before insert on companion_private.encounter_idempotency
for each row execute function companion_private.bind_terminal_encounter_to_claim();

revoke all on table companion_private.encounter_execution_claims
from public, anon, authenticated;
revoke all on function companion_private.claim_encounter_execution(
  uuid, text, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function companion_private.claim_encounter_execution(
  uuid, text, text, uuid, uuid, uuid, uuid
) to service_role;

comment on column public.encounter_invitations.claimed_at
is 'Durable one-shot claim established after preflight and before provider start; terminal delivery or non-delivery later sets used_at.';
comment on table companion_private.encounter_execution_claims
is 'Immutable binding between one invitation, one Encounter, one Compute reservation, and one publication reservation before provider I/O.';
comment on function companion_private.claim_encounter_execution(
  uuid, text, text, uuid, uuid, uuid, uuid
) is 'Atomically claims a mutually approved invitation for exactly one reserved, not-yet-started Encounter execution.';

commit;
