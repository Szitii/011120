begin;

create table companion_private.provider_call_reconciliations (
  id uuid primary key default gen_random_uuid(),
  execution_claim_id uuid not null unique references companion_private.encounter_execution_claims(id),
  actor_owner_id uuid not null references public.owners(id) on delete cascade,
  generation_transaction_id uuid not null unique references public.compute_transactions(id),
  ledger_entry_id uuid not null unique references public.compute_ledger_entries(id),
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  evidence_source text not null check (evidence_source in (
    'PROVIDER_RECORD_UNAVAILABLE', 'PROVIDER_QUERY_TIMEOUT', 'OPERATOR_CONFIRMED_UNKNOWN'
  )),
  reconciled_at timestamptz not null,
  conservative_input_tokens bigint not null check (conservative_input_tokens >= 0),
  conservative_output_tokens bigint not null check (conservative_output_tokens >= 0),
  conservative_cost_minor bigint not null check (conservative_cost_minor >= 0),
  provider_request_id_hash text check (
    provider_request_id_hash is null or provider_request_id_hash ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz not null default now()
);

create trigger provider_call_reconciliations_immutable
before update or delete on companion_private.provider_call_reconciliations
for each row execute function companion_private.reject_immutable_mutation();

revoke all on table companion_private.provider_call_reconciliations
from public, anon, authenticated;

create or replace function companion_private.reconcile_stale_started_encounter(
  p_actor_owner_id uuid,
  p_execution_claim_id uuid,
  p_reason_code text,
  p_evidence_source text,
  p_provider_request_id_hash text
)
returns table (
  encounter_id uuid,
  ledger_entry_id uuid,
  result_status text,
  outcome_code text,
  conservative_cost_minor bigint,
  invitation_consumed boolean,
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
  existing_reconciliation companion_private.provider_call_reconciliations%rowtype;
  invitation public.encounter_invitations%rowtype;
  compute_transaction public.compute_transactions%rowtype;
  provider_start public.compute_ledger_entries%rowtype;
  latest_compute public.compute_ledger_entries%rowtype;
  active_budget public.compute_budgets%rowtype;
  publication_reservation public.publication_reservations%rowtype;
  new_ledger_entry_id uuid := gen_random_uuid();
  reconciliation_time timestamptz := statement_timestamp();
  reconciliation_outcome constant text := 'STARTED_PROVIDER_OUTCOME_UNKNOWN';
begin
  if p_actor_owner_id is null or p_execution_claim_id is null
    or p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{2,63}$'
    or p_evidence_source not in (
      'PROVIDER_RECORD_UNAVAILABLE', 'PROVIDER_QUERY_TIMEOUT', 'OPERATOR_CONFIRMED_UNKNOWN'
    )
    or (p_provider_request_id_hash is not null
      and p_provider_request_id_hash !~ '^[a-f0-9]{64}$') then
    raise exception using errcode = '22023', message = 'invalid started Encounter reconciliation request';
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
    select * into existing_reconciliation
    from companion_private.provider_call_reconciliations as evidence
    where evidence.execution_claim_id = execution_claim.id;

    if not found
      or existing_run.result_status <> 'FAILED'
      or existing_run.outcome_code <> reconciliation_outcome
      or existing_run.encounter_id <> execution_claim.encounter_id
      or existing_reconciliation.reason_code <> p_reason_code
      or existing_reconciliation.evidence_source <> p_evidence_source
      or existing_reconciliation.provider_request_id_hash is distinct from p_provider_request_id_hash then
      raise exception using errcode = '23505',
        message = 'Encounter reconciliation replay does not match the terminal evidence';
    end if;

    return query select existing_run.encounter_id, existing_reconciliation.ledger_entry_id,
      existing_run.result_status, existing_run.outcome_code,
      existing_reconciliation.conservative_cost_minor, true, true, true;
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
    raise exception using errcode = '55000',
      message = 'started Encounter reconciliation does not own an active one-shot invitation';
  end if;

  select * into compute_transaction
  from public.compute_transactions as candidate
  where candidate.id = execution_claim.generation_transaction_id
    and candidate.reason_code = 'SOCIAL_ENCOUNTER_RESPONSE'
    and candidate.trigger_event_type = 'ENCOUNTER'
    and candidate.trigger_event_id = execution_claim.encounter_id
  for update;

  if not found or compute_transaction.owner_id <> invitation.responder_owner_id then
    raise exception using errcode = '55000',
      message = 'started Encounter reconciliation has no attributable Compute transaction';
  end if;

  select * into provider_start
  from public.compute_ledger_entries as entry
  where entry.transaction_id = compute_transaction.id
    and entry.entry_type = 'START' and entry.status = 'STARTED'
  order by entry.sequence asc
  limit 1;

  select * into latest_compute
  from public.compute_ledger_entries as entry
  where entry.transaction_id = compute_transaction.id
  order by entry.sequence desc
  limit 1
  for update;

  if not found or latest_compute.id is distinct from provider_start.id then
    raise exception using errcode = '55000',
      message = 'only an unsettled provider START may be reconciled';
  end if;
  if reconciliation_time < least(provider_start.created_at + interval '15 minutes', invitation.expires_at) then
    raise exception using errcode = '55000', message = 'started Encounter execution is not stale';
  end if;

  if compute_transaction.budget_id is null
    or compute_transaction.estimated_input_tokens is null
    or compute_transaction.max_output_tokens is null
    or compute_transaction.reserved_cost_minor is null then
    raise exception using errcode = '55000', message = 'Compute transaction lacks conservative reservation metadata';
  end if;

  select * into active_budget
  from public.compute_budgets as candidate
  where candidate.id = compute_transaction.budget_id
    and candidate.owner_id = compute_transaction.owner_id
    and candidate.companion_id = compute_transaction.companion_id
  for update;

  if not found
    or active_budget.reserved_calls < 1
    or active_budget.reserved_input_tokens < compute_transaction.estimated_input_tokens
    or active_budget.reserved_output_tokens < compute_transaction.max_output_tokens
    or active_budget.reserved_cost_minor < compute_transaction.reserved_cost_minor then
    raise exception using errcode = '55000', message = 'Compute reservation counters are inconsistent';
  end if;

  select * into publication_reservation
  from public.publication_reservations as candidate
  where candidate.id = execution_claim.publication_reservation_id
    and candidate.owner_id = compute_transaction.owner_id
    and candidate.companion_id = compute_transaction.companion_id
    and candidate.related_event_id = execution_claim.encounter_id
  for update;

  if not found or publication_reservation.status <> 'RESERVED' then
    raise exception using errcode = '55000',
      message = 'started Encounter reconciliation requires its active publication reservation';
  end if;

  update public.compute_budgets
  set reserved_calls = reserved_calls - 1,
      settled_calls = settled_calls + 1,
      reserved_input_tokens = reserved_input_tokens - compute_transaction.estimated_input_tokens,
      settled_input_tokens = settled_input_tokens + compute_transaction.estimated_input_tokens,
      reserved_output_tokens = reserved_output_tokens - compute_transaction.max_output_tokens,
      settled_output_tokens = settled_output_tokens + compute_transaction.max_output_tokens,
      reserved_cost_minor = reserved_cost_minor - compute_transaction.reserved_cost_minor,
      settled_cost_minor = settled_cost_minor + compute_transaction.reserved_cost_minor
  where id = active_budget.id;

  insert into public.compute_ledger_entries (
    id, owner_id, transaction_id, sequence, entry_type, status,
    input_tokens, output_tokens, actual_cost_minor, outcome_code, provider_request_id_hash
  ) values (
    new_ledger_entry_id, compute_transaction.owner_id, compute_transaction.id,
    latest_compute.sequence + 1, 'RECONCILIATION', 'RECONCILED',
    compute_transaction.estimated_input_tokens, compute_transaction.max_output_tokens,
    compute_transaction.reserved_cost_minor, reconciliation_outcome, p_provider_request_id_hash
  );

  insert into companion_private.provider_call_reconciliations (
    execution_claim_id, actor_owner_id, generation_transaction_id, ledger_entry_id,
    reason_code, evidence_source, reconciled_at, conservative_input_tokens,
    conservative_output_tokens, conservative_cost_minor, provider_request_id_hash
  ) values (
    execution_claim.id, p_actor_owner_id, compute_transaction.id, new_ledger_entry_id,
    p_reason_code, p_evidence_source, reconciliation_time,
    compute_transaction.estimated_input_tokens, compute_transaction.max_output_tokens,
    compute_transaction.reserved_cost_minor, p_provider_request_id_hash
  );

  perform companion_private.complete_publication_reservation(
    compute_transaction.owner_id, publication_reservation.id, 'RELEASED', reconciliation_outcome
  );

  update public.encounter_invitations
  set used_at = reconciliation_time
  where id = invitation.id;

  insert into companion_private.encounter_idempotency (
    owner_id, idempotency_key_hash, request_hash, encounter_id, result_status,
    invitation_id, generation_transaction_id, publication_reservation_id,
    safety_event_id, outcome_code
  ) values (
    execution_claim.actor_owner_id, execution_claim.idempotency_key_hash,
    execution_claim.request_hash, execution_claim.encounter_id, 'FAILED',
    execution_claim.invitation_id, execution_claim.generation_transaction_id,
    execution_claim.publication_reservation_id, null, reconciliation_outcome
  );

  return query select execution_claim.encounter_id, new_ledger_entry_id, 'FAILED'::text,
    reconciliation_outcome, compute_transaction.reserved_cost_minor, true, true, false;
end;
$$;

revoke all on function companion_private.reconcile_stale_started_encounter(
  uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function companion_private.reconcile_stale_started_encounter(
  uuid, uuid, text, text, text
) to service_role;

comment on table companion_private.provider_call_reconciliations
is 'Immutable evidence for conservative terminalization of stale provider STARTs; contains no prompt or completion body.';
comment on function companion_private.reconcile_stale_started_encounter(uuid, uuid, text, text, text)
is 'Atomically charges the full reserved ceiling for a stale unsettled Encounter START, consumes its invitation, releases publication, and creates no delivery artifacts.';

create or replace function public.get_compute_receipt(p_transaction_id uuid)
returns table (
  transaction_id uuid, owner_id uuid, companion_id uuid, social_twin_id uuid,
  reason_code text, trigger_event_type text, trigger_event_id uuid, provider_id text,
  canonical_model text, provider_model text, billing_party text, currency text,
  input_tokens bigint, output_tokens bigint, reserved_cost_minor bigint,
  actual_cost_minor bigint, outcome text, prompt_template_version text,
  identity_version integer, social_persona_version integer, memory_policy_version text,
  safety_policy_version text, router_version text, attempt_no integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select tx.id, tx.owner_id, tx.companion_id, tx.social_twin_id, tx.reason_code,
    tx.trigger_event_type, tx.trigger_event_id, tx.provider_id, tx.canonical_model,
    tx.provider_model, tx.billing_party, tx.currency,
    coalesce(usage_entry.input_tokens, 0), coalesce(usage_entry.output_tokens, 0),
    coalesce(first_entry.reserved_cost_minor, 0),
    coalesce(usage_entry.actual_cost_minor, 0) + coalesce(corrections.cost_delta_minor, 0),
    coalesce(terminal.status, first_entry.status), tx.prompt_template_version,
    tx.identity_version, tx.social_persona_version, tx.memory_policy_version,
    tx.safety_policy_version, tx.router_version, tx.attempt_no
  from public.compute_transactions as tx
  join lateral (
    select entry.* from public.compute_ledger_entries as entry
    where entry.transaction_id = tx.id order by entry.sequence asc limit 1
  ) as first_entry on true
  left join lateral (
    select entry.* from public.compute_ledger_entries as entry
    where entry.transaction_id = tx.id
      and entry.entry_type in ('SETTLEMENT', 'RECONCILIATION')
    order by entry.sequence desc limit 1
  ) as usage_entry on true
  left join lateral (
    select sum(entry.cost_delta_minor)::bigint as cost_delta_minor
    from public.compute_ledger_entries as entry
    where entry.transaction_id = tx.id and entry.entry_type = 'RECONCILIATION'
      and entry.id is distinct from usage_entry.id
  ) as corrections on true
  left join lateral (
    select entry.* from public.compute_ledger_entries as entry
    where entry.transaction_id = tx.id
      and entry.entry_type in ('SETTLEMENT', 'RECONCILIATION', 'RELEASE', 'REJECTION')
    order by entry.sequence desc limit 1
  ) as terminal on true
  where tx.id = p_transaction_id;
$$;

revoke all on function public.get_compute_receipt(uuid) from public, anon;
grant execute on function public.get_compute_receipt(uuid) to authenticated;

commit;
