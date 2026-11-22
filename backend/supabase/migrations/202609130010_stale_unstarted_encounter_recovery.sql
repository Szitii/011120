begin;

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

  if not found then
    raise exception using errcode = '55000',
      message = 'terminal Encounter result is not bound to a durable execution claim';
  end if;

  if exists (
    select 1
    from public.compute_ledger_entries as entry
    where entry.transaction_id = matching_claim.generation_transaction_id
      and entry.entry_type = 'START'
      and entry.status = 'STARTED'
      and entry.created_at >= matching_claim.claimed_at
  ) then
    new.execution_claim_id := matching_claim.id;
    return new;
  end if;

  if new.result_status = 'FAILED'
    and new.outcome_code = 'STALE_CLAIM_RECOVERED_BEFORE_PROVIDER'
    and new.safety_event_id is null
    and exists (
      select 1
      from public.compute_ledger_entries as entry
      where entry.transaction_id = matching_claim.generation_transaction_id
        and entry.entry_type = 'RELEASE'
        and entry.status = 'CANCELLED'
        and entry.outcome_code = 'STALE_CLAIM_RECOVERED_BEFORE_PROVIDER'
        and entry.created_at >= matching_claim.claimed_at
    ) then
    new.execution_claim_id := matching_claim.id;
    return new;
  end if;

  raise exception using errcode = '55000',
    message = 'terminal Encounter result is not bound to a claimed provider start or safe pre-provider recovery';
end;
$$;

create or replace function companion_private.recover_stale_unstarted_encounter(
  p_actor_owner_id uuid,
  p_execution_claim_id uuid
)
returns table (
  encounter_id uuid,
  result_status text,
  outcome_code text,
  invitation_consumed boolean,
  compute_released boolean,
  publication_released boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  execution_claim companion_private.encounter_execution_claims%rowtype;
  existing_run companion_private.encounter_idempotency%rowtype;
  invitation public.encounter_invitations%rowtype;
  compute_transaction public.compute_transactions%rowtype;
  latest_compute public.compute_ledger_entries%rowtype;
  publication_reservation public.publication_reservations%rowtype;
  recovery_time timestamptz := statement_timestamp();
  recovery_outcome constant text := 'STALE_CLAIM_RECOVERED_BEFORE_PROVIDER';
begin
  if p_actor_owner_id is null or p_execution_claim_id is null then
    raise exception using errcode = '22023', message = 'invalid stale Encounter recovery request';
  end if;

  select * into execution_claim
  from companion_private.encounter_execution_claims as claim
  where claim.id = p_execution_claim_id
    and claim.actor_owner_id = p_actor_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'Encounter execution claim not found for initiating Owner';
  end if;

  select * into existing_run
  from companion_private.encounter_idempotency as result
  where result.execution_claim_id = execution_claim.id;

  if found then
    if existing_run.result_status <> 'FAILED'
      or existing_run.outcome_code <> recovery_outcome
      or existing_run.encounter_id <> execution_claim.encounter_id
      or existing_run.invitation_id <> execution_claim.invitation_id
      or existing_run.generation_transaction_id <> execution_claim.generation_transaction_id
      or existing_run.publication_reservation_id <> execution_claim.publication_reservation_id then
      raise exception using errcode = '55000', message = 'Encounter execution claim already has a different terminal result';
    end if;
    return query select existing_run.encounter_id, existing_run.result_status,
      existing_run.outcome_code, true, true, true, true;
    return;
  end if;

  select * into invitation
  from public.encounter_invitations as candidate
  where candidate.id = execution_claim.invitation_id
    and candidate.initiator_owner_id = p_actor_owner_id
  for update;

  if not found
    or invitation.claimed_at is distinct from execution_claim.claimed_at
    or invitation.used_at is not null then
    raise exception using errcode = '55000', message = 'stale Encounter claim does not own an active one-shot invitation';
  end if;

  if recovery_time < least(execution_claim.claimed_at + interval '15 minutes', invitation.expires_at) then
    raise exception using errcode = '55000', message = 'Encounter execution claim is not stale';
  end if;

  select * into compute_transaction
  from public.compute_transactions as candidate
  where candidate.id = execution_claim.generation_transaction_id
    and candidate.reason_code = 'SOCIAL_ENCOUNTER_RESPONSE'
    and candidate.trigger_event_type = 'ENCOUNTER'
    and candidate.trigger_event_id = execution_claim.encounter_id
  for update;

  if not found then
    raise exception using errcode = '55000', message = 'stale Encounter claim has no attributable Compute transaction';
  end if;

  select * into latest_compute
  from public.compute_ledger_entries as entry
  where entry.transaction_id = compute_transaction.id
  order by entry.sequence desc
  limit 1;

  if latest_compute.entry_type = 'START' and latest_compute.status = 'STARTED' then
    raise exception using errcode = '55000',
      message = 'started Encounter execution requires provider reconciliation, not pre-provider recovery';
  end if;
  if latest_compute.entry_type <> 'RESERVATION' or latest_compute.status <> 'RESERVED' then
    raise exception using errcode = '55000', message = 'Encounter execution is not an unstarted reservation';
  end if;

  select * into publication_reservation
  from public.publication_reservations as candidate
  where candidate.id = execution_claim.publication_reservation_id
    and candidate.owner_id = compute_transaction.owner_id
    and candidate.related_event_id = execution_claim.encounter_id
  for update;

  if not found or publication_reservation.status <> 'RESERVED' then
    raise exception using errcode = '55000', message = 'stale Encounter claim has no active publication reservation';
  end if;

  perform companion_private.release_compute_transaction(
    compute_transaction.owner_id, compute_transaction.id, recovery_outcome
  );
  perform companion_private.complete_publication_reservation(
    compute_transaction.owner_id, publication_reservation.id, 'RELEASED', recovery_outcome
  );

  update public.encounter_invitations
  set used_at = recovery_time
  where id = invitation.id;

  insert into companion_private.encounter_idempotency (
    owner_id, idempotency_key_hash, request_hash, encounter_id, result_status,
    invitation_id, generation_transaction_id, publication_reservation_id,
    safety_event_id, outcome_code
  ) values (
    execution_claim.actor_owner_id, execution_claim.idempotency_key_hash,
    execution_claim.request_hash, execution_claim.encounter_id, 'FAILED',
    execution_claim.invitation_id, execution_claim.generation_transaction_id,
    execution_claim.publication_reservation_id, null, recovery_outcome
  );

  return query select execution_claim.encounter_id, 'FAILED'::text, recovery_outcome,
    true, true, true, false;
end;
$$;

revoke all on function companion_private.recover_stale_unstarted_encounter(uuid, uuid)
from public, anon, authenticated;
grant execute on function companion_private.recover_stale_unstarted_encounter(uuid, uuid)
to service_role;

comment on function companion_private.recover_stale_unstarted_encounter(uuid, uuid)
is 'After a fixed grace period or invitation expiry, atomically terminalizes a claimed Encounter that has no provider START. Started work must be reconciled and is never released as zero-cost.';

commit;
