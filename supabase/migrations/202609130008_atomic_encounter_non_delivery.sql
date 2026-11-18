begin;

alter table companion_private.encounter_idempotency
  add column invitation_id uuid references public.encounter_invitations(id),
  add column generation_transaction_id uuid references public.compute_transactions(id),
  add column safety_event_id uuid references companion_private.encounter_safety_events(id),
  add column outcome_code text;

create or replace function companion_private.persist_encounter_non_delivery(
  p_actor_owner_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_encounter_id uuid,
  p_invitation_id uuid,
  p_result_status text,
  p_outcome_code text,
  p_generation_transaction_id uuid,
  p_publication_reservation_id uuid,
  p_safety_event_id uuid,
  p_occurred_at timestamptz
)
returns table (
  encounter_id uuid,
  result_status text,
  outcome_code text,
  invitation_consumed boolean,
  publication_released boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_run companion_private.encounter_idempotency%rowtype;
  invitation public.encounter_invitations%rowtype;
  initiator_twin public.social_twins%rowtype;
  responder_twin public.social_twins%rowtype;
  compute_transaction public.compute_transactions%rowtype;
  provider_start public.compute_ledger_entries%rowtype;
  terminal_compute public.compute_ledger_entries%rowtype;
  safety_event companion_private.encounter_safety_events%rowtype;
  publication_reservation public.publication_reservations%rowtype;
  after_provider boolean := p_generation_transaction_id is not null;
begin
  if p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_actor_owner_id is null
    or p_encounter_id is null
    or p_invitation_id is null
    or p_result_status not in ('BLOCKED', 'FAILED')
    or p_outcome_code is null or btrim(p_outcome_code) = ''
    or p_occurred_at is null then
    raise exception using errcode = '22023', message = 'invalid non-delivery Encounter persistence request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_actor_owner_id::text || ':' || p_idempotency_key_hash, 0));

  select * into existing_run
  from companion_private.encounter_idempotency as candidate
  where candidate.owner_id = p_actor_owner_id
    and candidate.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    if existing_run.request_hash <> p_request_hash
      or existing_run.encounter_id <> p_encounter_id
      or existing_run.result_status <> p_result_status
      or existing_run.outcome_code is distinct from p_outcome_code
      or existing_run.invitation_id is distinct from p_invitation_id
      or existing_run.generation_transaction_id is distinct from p_generation_transaction_id
      or existing_run.publication_reservation_id is distinct from p_publication_reservation_id
      or existing_run.safety_event_id is distinct from p_safety_event_id then
      raise exception using errcode = '23505', message = 'Encounter idempotency key reused with a different non-delivery result';
    end if;
    if existing_run.artifact_id is not null
      or existing_run.initiator_life_event_id is not null
      or existing_run.responder_life_event_id is not null then
      raise exception using errcode = '55000', message = 'non-delivery Encounter idempotency record contains delivery artifacts';
    end if;
    return query select existing_run.encounter_id, existing_run.result_status,
      existing_run.outcome_code, existing_run.generation_transaction_id is not null,
      existing_run.publication_reservation_id is not null, true;
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
  if invitation.used_at is not null or invitation.max_uses <> 1 then
    raise exception using errcode = '55000', message = 'Encounter invitation is not available for this result';
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

  if not after_provider then
    if p_result_status <> 'BLOCKED'
      or p_outcome_code <> 'INPUT_SAFETY_BLOCK'
      or p_publication_reservation_id is not null
      or p_safety_event_id is null
      or p_occurred_at < invitation.created_at
      or p_occurred_at >= invitation.expires_at then
      raise exception using errcode = '55000', message = 'pre-provider non-delivery must be a current input safety block';
    end if;

    select * into safety_event
    from companion_private.encounter_safety_events as candidate
    where candidate.id = p_safety_event_id
      and candidate.owner_id = invitation.responder_owner_id
      and candidate.companion_id = responder_twin.companion_id
      and candidate.social_twin_id = invitation.responder_twin_id
      and candidate.direction = 'INPUT'
      and candidate.decision = 'BLOCK'
      and candidate.related_encounter_id = p_encounter_id;
    if not found then
      raise exception using errcode = '42501', message = 'input safety evidence does not authorize this blocked result';
    end if;

    insert into companion_private.encounter_idempotency (
      owner_id, idempotency_key_hash, request_hash, encounter_id, result_status,
      invitation_id, safety_event_id, outcome_code
    ) values (
      p_actor_owner_id, p_idempotency_key_hash, p_request_hash, p_encounter_id,
      p_result_status, invitation.id, safety_event.id, p_outcome_code
    );

    return query select p_encounter_id, p_result_status, p_outcome_code, false, false, false;
    return;
  end if;

  if p_publication_reservation_id is null then
    raise exception using errcode = '55000', message = 'post-provider non-delivery requires a publication reservation';
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

  select * into provider_start
  from public.compute_ledger_entries as entry
  where entry.transaction_id = p_generation_transaction_id
    and entry.entry_type = 'START'
    and entry.status = 'STARTED'
  order by entry.sequence asc
  limit 1;
  if not found
    or provider_start.created_at < invitation.created_at
    or invitation.expires_at <= provider_start.created_at then
    raise exception using errcode = '55000', message = 'provider work did not start inside the invitation window';
  end if;
  if p_occurred_at < provider_start.created_at then
    raise exception using errcode = '22023', message = 'non-delivery cannot precede provider start';
  end if;

  select * into terminal_compute
  from public.compute_ledger_entries as entry
  where entry.transaction_id = p_generation_transaction_id
  order by entry.sequence desc
  limit 1;
  if not found or terminal_compute.entry_type <> 'SETTLEMENT'
    or terminal_compute.status <> p_result_status
    or terminal_compute.outcome_code is distinct from p_outcome_code then
    raise exception using errcode = '55000', message = 'non-delivery result does not match terminal Compute status';
  end if;

  if p_result_status = 'BLOCKED' then
    if p_safety_event_id is null then
      raise exception using errcode = '42501', message = 'output safety evidence is required for a blocked result';
    end if;
    select * into safety_event
    from companion_private.encounter_safety_events as candidate
    where candidate.id = p_safety_event_id
      and candidate.owner_id = invitation.responder_owner_id
      and candidate.companion_id = responder_twin.companion_id
      and candidate.social_twin_id = invitation.responder_twin_id
      and candidate.direction = 'OUTPUT'
      and candidate.decision = 'BLOCK'
      and candidate.related_encounter_id = p_encounter_id;
    if not found then
      raise exception using errcode = '42501', message = 'output safety evidence does not authorize this blocked result';
    end if;
  elsif p_safety_event_id is not null then
    raise exception using errcode = '22023', message = 'failed provider result must not claim output safety evidence';
  end if;

  select * into publication_reservation
  from public.publication_reservations as candidate
  where candidate.id = p_publication_reservation_id
    and candidate.owner_id = invitation.responder_owner_id
    and candidate.companion_id = responder_twin.companion_id
    and candidate.related_event_id = p_encounter_id
  for update;
  if not found or publication_reservation.status <> 'RESERVED' then
    raise exception using errcode = '55000', message = 'active publication reservation is required for non-delivery';
  end if;

  update public.encounter_invitations
  set used_at = p_occurred_at
  where id = invitation.id;

  perform companion_private.complete_publication_reservation(
    invitation.responder_owner_id, publication_reservation.id, 'RELEASED', p_outcome_code
  );

  insert into companion_private.encounter_idempotency (
    owner_id, idempotency_key_hash, request_hash, encounter_id, result_status,
    invitation_id, generation_transaction_id, publication_reservation_id,
    safety_event_id, outcome_code
  ) values (
    p_actor_owner_id, p_idempotency_key_hash, p_request_hash, p_encounter_id,
    p_result_status, invitation.id, compute_transaction.id, publication_reservation.id,
    p_safety_event_id, p_outcome_code
  );

  return query select p_encounter_id, p_result_status, p_outcome_code, true, true, false;
end;
$$;

revoke all on function companion_private.persist_encounter_non_delivery(
  uuid, text, text, uuid, uuid, text, text, uuid, uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function companion_private.persist_encounter_non_delivery(
  uuid, text, text, uuid, uuid, text, text, uuid, uuid, uuid, timestamptz
) to service_role;

comment on function companion_private.persist_encounter_non_delivery(
  uuid, text, text, uuid, uuid, text, text, uuid, uuid, uuid, timestamptz
) is 'Persists blocked/failed Encounter idempotency; pre-provider blocks preserve the invitation, while post-provider terminal outcomes consume it and release publication without Artifact or Life Event.';

commit;
