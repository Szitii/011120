begin;

alter table public.publication_reservations
  drop constraint publication_reservations_status_check,
  add column idempotency_key_hash text,
  add column request_hash text,
  add column outcome_code text;

update public.publication_reservations
set idempotency_key_hash = encode(digest('legacy-publication:' || id::text, 'sha256'), 'hex'),
    request_hash = encode(digest('legacy-publication-request:' || id::text, 'sha256'), 'hex')
where idempotency_key_hash is null or request_hash is null;

alter table public.publication_reservations
  alter column idempotency_key_hash set not null,
  alter column request_hash set not null,
  add constraint publication_reservations_idempotency_hash_check
    check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  add constraint publication_reservations_request_hash_check
    check (request_hash ~ '^[a-f0-9]{64}$'),
  add constraint publication_reservations_status_check
    check (status in ('RESERVED', 'CONSUMED', 'RELEASED', 'REJECTED')),
  add constraint publication_reservations_owner_idempotency_unique
    unique (owner_id, idempotency_key_hash),
  add constraint publication_reservations_id_owner_unique
    unique (id, owner_id);

alter table companion_private.encounter_safety_events
  add column sanitized_content_hash text
    check (sanitized_content_hash is null or sanitized_content_hash ~ '^[a-f0-9]{64}$');

alter table companion_private.encounter_idempotency
  add column publication_reservation_id uuid,
  add column artifact_id uuid,
  add column initiator_life_event_id uuid,
  add column responder_life_event_id uuid,
  add constraint encounter_idempotency_encounter_unique unique (encounter_id),
  add constraint encounter_idempotency_publication_fk
    foreign key (publication_reservation_id)
    references public.publication_reservations(id),
  add constraint encounter_idempotency_artifact_fk
    foreign key (artifact_id) references public.encounter_artifacts(id),
  add constraint encounter_idempotency_initiator_life_event_fk
    foreign key (initiator_life_event_id) references public.life_events(id),
  add constraint encounter_idempotency_responder_life_event_fk
    foreign key (responder_life_event_id) references public.life_events(id);

create or replace function companion_private.allow_publication_terminal_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    or old.status <> 'RESERVED'
    or new.status not in ('CONSUMED', 'RELEASED')
    or old.completed_at is not null
    or new.completed_at is null
    or (to_jsonb(new) - array['status', 'completed_at', 'outcome_code'])
       <> (to_jsonb(old) - array['status', 'completed_at', 'outcome_code']) then
    raise exception using errcode = '55000', message = 'publication reservations may only transition once to a terminal state';
  end if;
  return new;
end;
$$;

create trigger publication_reservations_terminal_only
before update or delete on public.publication_reservations
for each row execute function companion_private.allow_publication_terminal_transition();

create trigger encounter_idempotency_immutable
before update or delete on companion_private.encounter_idempotency
for each row execute function companion_private.reject_immutable_mutation();

create or replace function companion_private.reserve_publication(
  p_owner_id uuid,
  p_companion_id uuid,
  p_related_event_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text
)
returns table (
  reservation_id uuid,
  budget_id uuid,
  decision text,
  outcome_code text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_reservation public.publication_reservations%rowtype;
  active_budget public.publication_budgets%rowtype;
  new_reservation_id uuid := gen_random_uuid();
begin
  if p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid publication attribution';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_idempotency_key_hash, 0));

  select * into existing_reservation
  from public.publication_reservations as candidate
  where candidate.owner_id = p_owner_id
    and candidate.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    if existing_reservation.request_hash <> p_request_hash
      or existing_reservation.companion_id <> p_companion_id
      or existing_reservation.related_event_id <> p_related_event_id then
      raise exception using errcode = '23505', message = 'publication idempotency key reused with a different request';
    end if;
    return query select existing_reservation.id, existing_reservation.budget_id,
      existing_reservation.status, existing_reservation.outcome_code, true;
    return;
  end if;

  select * into active_budget
  from public.publication_budgets as candidate
  where candidate.owner_id = p_owner_id
    and candidate.companion_id = p_companion_id
    and candidate.period_start <= now()
    and now() < candidate.period_end
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'active publication budget missing';
  end if;

  if active_budget.reserved_publications + active_budget.consumed_publications + 1
    > active_budget.max_publications then
    insert into public.publication_reservations (
      id, budget_id, owner_id, companion_id, related_event_id, status,
      completed_at, idempotency_key_hash, request_hash, outcome_code
    ) values (
      new_reservation_id, active_budget.id, p_owner_id, p_companion_id, p_related_event_id,
      'REJECTED', now(), p_idempotency_key_hash, p_request_hash, 'PUBLICATION_BUDGET_EXHAUSTED'
    );
    return query select new_reservation_id, active_budget.id, 'REJECTED'::text,
      'PUBLICATION_BUDGET_EXHAUSTED'::text, false;
    return;
  end if;

  update public.publication_budgets
  set reserved_publications = reserved_publications + 1
  where id = active_budget.id;

  insert into public.publication_reservations (
    id, budget_id, owner_id, companion_id, related_event_id, status,
    idempotency_key_hash, request_hash
  ) values (
    new_reservation_id, active_budget.id, p_owner_id, p_companion_id, p_related_event_id,
    'RESERVED', p_idempotency_key_hash, p_request_hash
  );

  return query select new_reservation_id, active_budget.id, 'RESERVED'::text, null::text, false;
end;
$$;

create or replace function companion_private.complete_publication_reservation(
  p_owner_id uuid,
  p_reservation_id uuid,
  p_decision text,
  p_outcome_code text
)
returns table (
  reservation_id uuid,
  decision text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  publication_reservation public.publication_reservations%rowtype;
  active_budget public.publication_budgets%rowtype;
begin
  if p_decision not in ('CONSUMED', 'RELEASED')
    or p_outcome_code is null or btrim(p_outcome_code) = '' then
    raise exception using errcode = '22023', message = 'invalid publication completion';
  end if;

  select * into publication_reservation
  from public.publication_reservations as candidate
  where candidate.id = p_reservation_id and candidate.owner_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'publication reservation not found for Owner';
  end if;

  if publication_reservation.status in ('CONSUMED', 'RELEASED') then
    if publication_reservation.status = p_decision
      and publication_reservation.outcome_code = p_outcome_code then
      return query select publication_reservation.id, publication_reservation.status, true;
      return;
    end if;
    raise exception using errcode = '23505', message = 'publication completion replay does not match the terminal decision';
  end if;

  if publication_reservation.status <> 'RESERVED' then
    raise exception using errcode = '55000', message = 'only a reserved publication may complete';
  end if;

  select * into active_budget
  from public.publication_budgets as candidate
  where candidate.id = publication_reservation.budget_id
    and candidate.owner_id = p_owner_id
    and candidate.companion_id = publication_reservation.companion_id
  for update;

  if not found or active_budget.reserved_publications < 1 then
    raise exception using errcode = '55000', message = 'publication reservation counters are inconsistent';
  end if;

  update public.publication_budgets
  set reserved_publications = reserved_publications - 1,
      consumed_publications = consumed_publications + case when p_decision = 'CONSUMED' then 1 else 0 end
  where id = active_budget.id;

  update public.publication_reservations
  set status = p_decision,
      outcome_code = p_outcome_code,
      completed_at = now()
  where id = publication_reservation.id;

  return query select publication_reservation.id, p_decision, false;
end;
$$;

create or replace function companion_private.persist_delivered_encounter(
  p_actor_owner_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_encounter_id uuid,
  p_invitation_id uuid,
  p_publication_reservation_id uuid,
  p_body text,
  p_body_hash text,
  p_artifact_status text,
  p_generation_transaction_id uuid,
  p_output_safety_event_id uuid,
  p_occurred_at timestamptz
)
returns table (
  encounter_id uuid,
  artifact_id uuid,
  initiator_life_event_id uuid,
  responder_life_event_id uuid,
  result_status text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_run companion_private.encounter_idempotency%rowtype;
  invitation public.encounter_invitations%rowtype;
  compute_transaction public.compute_transactions%rowtype;
  terminal_compute public.compute_ledger_entries%rowtype;
  output_safety companion_private.encounter_safety_events%rowtype;
  publication_reservation public.publication_reservations%rowtype;
  initiator_twin public.social_twins%rowtype;
  responder_twin public.social_twins%rowtype;
  new_artifact_id uuid := gen_random_uuid();
  new_initiator_life_event_id uuid := gen_random_uuid();
  new_responder_life_event_id uuid := gen_random_uuid();
  new_initiator_inbox_id uuid := gen_random_uuid();
  new_responder_inbox_id uuid := gen_random_uuid();
begin
  if p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_body_hash is null or p_body_hash !~ '^[a-f0-9]{64}$'
    or p_body is null or char_length(p_body) not between 1 and 2000
    or p_artifact_status not in ('DELIVERED', 'REDACTED')
    or p_occurred_at is null then
    raise exception using errcode = '22023', message = 'invalid delivered Encounter persistence request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_actor_owner_id::text || ':' || p_idempotency_key_hash, 0));

  select * into existing_run
  from companion_private.encounter_idempotency as candidate
  where candidate.owner_id = p_actor_owner_id
    and candidate.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    if existing_run.request_hash <> p_request_hash
      or existing_run.encounter_id <> p_encounter_id
      or existing_run.result_status <> p_artifact_status then
      raise exception using errcode = '23505', message = 'Encounter idempotency key reused with a different request';
    end if;
    if existing_run.artifact_id is null
      or existing_run.initiator_life_event_id is null
      or existing_run.responder_life_event_id is null then
      raise exception using errcode = '55000', message = 'delivered Encounter idempotency record is incomplete';
    end if;
    return query select existing_run.encounter_id, existing_run.artifact_id,
      existing_run.initiator_life_event_id, existing_run.responder_life_event_id,
      existing_run.result_status, true;
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
  if invitation.used_at is not null or invitation.max_uses <> 1 or invitation.expires_at <= now() then
    raise exception using errcode = '55000', message = 'Encounter invitation is not active and one-shot';
  end if;
  if not invitation.approved_by_owner_ids @> array[invitation.initiator_owner_id, invitation.responder_owner_id] then
    raise exception using errcode = '42501', message = 'mutual Owner approval is required';
  end if;

  select * into initiator_twin from public.social_twins
  where id = invitation.initiator_twin_id and owner_id = invitation.initiator_owner_id and status = 'ACTIVE';
  if not found then
    raise exception using errcode = '55000', message = 'initiator Social Twin is not active';
  end if;
  select * into responder_twin from public.social_twins
  where id = invitation.responder_twin_id and owner_id = invitation.responder_owner_id and status = 'ACTIVE';
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

  select * into terminal_compute
  from public.compute_ledger_entries as entry
  where entry.transaction_id = p_generation_transaction_id
  order by entry.sequence desc
  limit 1;
  if not found or terminal_compute.entry_type <> 'SETTLEMENT' or terminal_compute.status <> 'SUCCEEDED' then
    raise exception using errcode = '55000', message = 'only successfully settled generation may be delivered';
  end if;

  select * into output_safety
  from companion_private.encounter_safety_events as candidate
  where candidate.id = p_output_safety_event_id
    and candidate.owner_id = invitation.responder_owner_id
    and candidate.companion_id = responder_twin.companion_id
    and candidate.social_twin_id = invitation.responder_twin_id
    and candidate.direction = 'OUTPUT'
    and candidate.related_encounter_id = p_encounter_id;
  if not found
    or output_safety.sanitized_content_hash is distinct from p_body_hash
    or (p_artifact_status = 'DELIVERED' and output_safety.decision <> 'ALLOW')
    or (p_artifact_status = 'REDACTED' and output_safety.decision <> 'REDACT') then
    raise exception using errcode = '42501', message = 'output safety evidence does not authorize this artifact';
  end if;

  select * into publication_reservation
  from public.publication_reservations as candidate
  where candidate.id = p_publication_reservation_id
    and candidate.owner_id = invitation.responder_owner_id
    and candidate.companion_id = responder_twin.companion_id
    and candidate.related_event_id = p_encounter_id
  for update;
  if not found or publication_reservation.status <> 'RESERVED' then
    raise exception using errcode = '55000', message = 'active publication reservation is required';
  end if;

  update public.encounter_invitations set used_at = p_occurred_at where id = invitation.id;

  insert into public.encounter_artifacts (
    id, invitation_id, initiator_owner_id, initiator_twin_id, responder_owner_id,
    responder_twin_id, body, status, generation_transaction_id, safety_event_id, created_at
  ) values (
    new_artifact_id, invitation.id, invitation.initiator_owner_id, invitation.initiator_twin_id,
    invitation.responder_owner_id, invitation.responder_twin_id, p_body, p_artifact_status,
    p_generation_transaction_id, p_output_safety_event_id, p_occurred_at
  );

  insert into public.life_events (
    id, owner_id, companion_id, kind, title, structured_state, source, visibility_domain,
    occurred_at, requires_personality_decision, decision_transaction_id, idempotency_key
  ) values
    (new_initiator_life_event_id, invitation.initiator_owner_id, initiator_twin.companion_id,
     'SOCIAL_ENCOUNTER', 'A bounded companion encounter completed',
     jsonb_build_object('encounterArtifactId', new_artifact_id, 'counterpartTwinId', invitation.responder_twin_id, 'role', 'INITIATOR'),
     'SOCIAL', 'OWNER_ONLY', p_occurred_at, false, p_generation_transaction_id,
     'encounter-life:' || new_artifact_id::text || ':INITIATOR'),
    (new_responder_life_event_id, invitation.responder_owner_id, responder_twin.companion_id,
     'SOCIAL_ENCOUNTER', 'A bounded companion encounter completed',
     jsonb_build_object('encounterArtifactId', new_artifact_id, 'counterpartTwinId', invitation.initiator_twin_id, 'role', 'RESPONDER'),
     'SOCIAL', 'OWNER_ONLY', p_occurred_at, false, p_generation_transaction_id,
     'encounter-life:' || new_artifact_id::text || ':RESPONDER');

  insert into public.life_event_inbox (
    id, owner_id, companion_id, life_event_id, title, created_at
  ) values
    (new_initiator_inbox_id, invitation.initiator_owner_id, initiator_twin.companion_id,
     new_initiator_life_event_id, 'A bounded companion encounter completed', p_occurred_at),
    (new_responder_inbox_id, invitation.responder_owner_id, responder_twin.companion_id,
     new_responder_life_event_id, 'A bounded companion encounter completed', p_occurred_at);

  perform companion_private.complete_publication_reservation(
    invitation.responder_owner_id, publication_reservation.id, 'CONSUMED', p_artifact_status
  );

  insert into companion_private.encounter_idempotency (
    owner_id, idempotency_key_hash, request_hash, encounter_id, result_status,
    publication_reservation_id, artifact_id, initiator_life_event_id, responder_life_event_id
  ) values (
    p_actor_owner_id, p_idempotency_key_hash, p_request_hash, p_encounter_id, p_artifact_status,
    publication_reservation.id, new_artifact_id, new_initiator_life_event_id, new_responder_life_event_id
  );

  return query select p_encounter_id, new_artifact_id, new_initiator_life_event_id,
    new_responder_life_event_id, p_artifact_status, false;
end;
$$;

create or replace function public.get_compute_receipt(p_transaction_id uuid)
returns table (
  transaction_id uuid,
  owner_id uuid,
  companion_id uuid,
  social_twin_id uuid,
  reason_code text,
  trigger_event_type text,
  trigger_event_id uuid,
  provider_id text,
  canonical_model text,
  provider_model text,
  billing_party text,
  currency text,
  input_tokens bigint,
  output_tokens bigint,
  reserved_cost_minor bigint,
  actual_cost_minor bigint,
  outcome text,
  prompt_template_version text,
  identity_version integer,
  social_persona_version integer,
  memory_policy_version text,
  safety_policy_version text,
  router_version text,
  attempt_no integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select tx.id,
    tx.owner_id,
    tx.companion_id,
    tx.social_twin_id,
    tx.reason_code,
    tx.trigger_event_type,
    tx.trigger_event_id,
    tx.provider_id,
    tx.canonical_model,
    tx.provider_model,
    tx.billing_party,
    tx.currency,
    coalesce(settlement.input_tokens, 0),
    coalesce(settlement.output_tokens, 0),
    coalesce(first_entry.reserved_cost_minor, 0),
    coalesce(settlement.actual_cost_minor, 0) + coalesce(reconciliation.cost_delta_minor, 0),
    coalesce(terminal.status, first_entry.status),
    tx.prompt_template_version,
    tx.identity_version,
    tx.social_persona_version,
    tx.memory_policy_version,
    tx.safety_policy_version,
    tx.router_version,
    tx.attempt_no
  from public.compute_transactions as tx
  join lateral (
    select entry.* from public.compute_ledger_entries as entry
    where entry.transaction_id = tx.id
    order by entry.sequence asc limit 1
  ) as first_entry on true
  left join lateral (
    select entry.* from public.compute_ledger_entries as entry
    where entry.transaction_id = tx.id and entry.entry_type = 'SETTLEMENT'
    order by entry.sequence desc limit 1
  ) as settlement on true
  left join lateral (
    select sum(entry.cost_delta_minor)::bigint as cost_delta_minor
    from public.compute_ledger_entries as entry
    where entry.transaction_id = tx.id and entry.entry_type = 'RECONCILIATION'
  ) as reconciliation on true
  left join lateral (
    select entry.* from public.compute_ledger_entries as entry
    where entry.transaction_id = tx.id
      and entry.entry_type in ('SETTLEMENT', 'RELEASE', 'REJECTION')
    order by entry.sequence desc limit 1
  ) as terminal on true
  where tx.id = p_transaction_id;
$$;

revoke all on function companion_private.reserve_publication(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function companion_private.complete_publication_reservation(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function companion_private.persist_delivered_encounter(
  uuid, text, text, uuid, uuid, uuid, text, text, text, uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function companion_private.reserve_publication(uuid, uuid, uuid, text, text)
  to service_role;
grant execute on function companion_private.complete_publication_reservation(uuid, uuid, text, text)
  to service_role;
grant execute on function companion_private.persist_delivered_encounter(
  uuid, text, text, uuid, uuid, uuid, text, text, text, uuid, uuid, timestamptz
) to service_role;

revoke all on function public.get_compute_receipt(uuid) from public, anon;
grant execute on function public.get_compute_receipt(uuid) to authenticated;

comment on function companion_private.reserve_publication(uuid, uuid, uuid, text, text)
  is 'Atomically reserves an independent publication allowance with durable Owner-scoped idempotency.';
comment on function companion_private.persist_delivered_encounter(
  uuid, text, text, uuid, uuid, uuid, text, text, text, uuid, uuid, timestamptz
) is 'Atomically consumes a one-shot invitation and publication hold, then writes only safety-authorized Artifact and Owner-only Life Events.';
comment on function public.get_compute_receipt(uuid)
  is 'Owner-scoped receipt derived from immutable Compute attribution and ledger facts; excludes prompts, completions, credentials, and memory content.';

commit;
