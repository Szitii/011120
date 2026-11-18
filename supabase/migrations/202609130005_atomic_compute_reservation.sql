begin;

alter table public.compute_transactions
add column budget_id uuid references public.compute_budgets(id),
add column request_hash text check (request_hash is null or request_hash ~ '^[a-f0-9]{64}$'),
add column estimated_input_tokens bigint check (estimated_input_tokens is null or estimated_input_tokens >= 0),
add column max_output_tokens bigint check (max_output_tokens is null or max_output_tokens >= 0),
add column reserved_cost_minor bigint check (reserved_cost_minor is null or reserved_cost_minor >= 0);

create table companion_private.compute_reason_policies (
  reason_code text primary key,
  billing_party text not null check (billing_party in ('OWNER', 'PLATFORM', 'PROMOTION')),
  max_input_tokens bigint not null check (max_input_tokens >= 0),
  max_output_tokens bigint not null check (max_output_tokens >= 0),
  max_reserved_cost_minor bigint not null check (max_reserved_cost_minor >= 0),
  public_output boolean not null,
  registry_version text not null,
  created_at timestamptz not null default now()
);

insert into companion_private.compute_reason_policies
  (reason_code, billing_party, max_input_tokens, max_output_tokens, max_reserved_cost_minor, public_output, registry_version)
values
  ('IMPORT_IDENTITY_SUMMARY', 'OWNER', 8000, 1000, 100, false, 'compute-reasons/0.1.0'),
  ('MEMORY_CONSOLIDATION', 'OWNER', 8000, 1000, 100, false, 'compute-reasons/0.1.0'),
  ('OWNER_DIRECT_RESPONSE', 'OWNER', 16000, 2000, 200, false, 'compute-reasons/0.1.0'),
  ('SOCIAL_ENCOUNTER_RESPONSE', 'OWNER', 4000, 800, 100, true, 'compute-reasons/0.1.0'),
  ('LIFE_EVENT_EXPRESSION', 'OWNER', 4000, 800, 100, false, 'compute-reasons/0.1.0'),
  ('SAFETY_CLASSIFICATION', 'PLATFORM', 4000, 200, 50, false, 'compute-reasons/0.1.0'),
  ('DLP_CLASSIFICATION', 'PLATFORM', 4000, 200, 50, false, 'compute-reasons/0.1.0');

create trigger compute_reason_policies_immutable
before update or delete on companion_private.compute_reason_policies
for each row execute function companion_private.reject_immutable_mutation();

create or replace function companion_private.reserve_compute_transaction(
  p_owner_id uuid,
  p_companion_id uuid,
  p_social_twin_id uuid,
  p_reason_code text,
  p_trigger_event_type text,
  p_trigger_event_id uuid,
  p_provider_id text,
  p_credential_id uuid,
  p_canonical_model text,
  p_provider_model text,
  p_billing_party text,
  p_currency text,
  p_pricing_version text,
  p_estimated_input_tokens bigint,
  p_max_output_tokens bigint,
  p_reserved_cost_minor bigint,
  p_prompt_template_version text,
  p_identity_version integer,
  p_social_persona_version integer,
  p_memory_policy_version text,
  p_safety_policy_version text,
  p_router_version text,
  p_trace_id text,
  p_attempt_no integer,
  p_retry_parent_transaction_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text
)
returns table (
  transaction_id uuid,
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
  existing_transaction public.compute_transactions%rowtype;
  active_budget public.compute_budgets%rowtype;
  reason_policy companion_private.compute_reason_policies%rowtype;
  new_transaction_id uuid := gen_random_uuid();
  rejection_code text;
  existing_decision text;
  existing_outcome text;
begin
  if p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_trace_id is null or btrim(p_trace_id) = ''
    or p_trigger_event_type is null or btrim(p_trigger_event_type) = ''
    or p_provider_id is null or btrim(p_provider_id) = ''
    or p_canonical_model is null or btrim(p_canonical_model) = ''
    or p_provider_model is null or btrim(p_provider_model) = ''
    or p_pricing_version is null or btrim(p_pricing_version) = ''
    or p_prompt_template_version is null or btrim(p_prompt_template_version) = ''
    or p_memory_policy_version is null or btrim(p_memory_policy_version) = ''
    or p_safety_policy_version is null or btrim(p_safety_policy_version) = ''
    or p_router_version is null or btrim(p_router_version) = ''
    or p_estimated_input_tokens is null or p_estimated_input_tokens < 0
    or p_max_output_tokens is null or p_max_output_tokens < 0
    or p_reserved_cost_minor is null or p_reserved_cost_minor < 0
    or p_identity_version is null or p_identity_version <= 0
    or p_attempt_no is null or p_attempt_no <= 0 then
    raise exception using errcode = '22023', message = 'invalid or incomplete compute attribution';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_idempotency_key_hash, 0));

  select * into existing_transaction
  from public.compute_transactions as candidate
  where candidate.owner_id = p_owner_id
    and candidate.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    if existing_transaction.request_hash is null or existing_transaction.request_hash <> p_request_hash then
      raise exception using errcode = '23505', message = 'compute idempotency key reused with a different request';
    end if;

    select entry.status, entry.outcome_code
    into existing_decision, existing_outcome
    from public.compute_ledger_entries as entry
    where entry.transaction_id = existing_transaction.id and entry.sequence = 1;

    if existing_decision is null then
      raise exception using errcode = '55000', message = 'idempotent compute transaction is missing its first ledger fact';
    end if;

    return query select
      existing_transaction.id,
      existing_transaction.budget_id,
      existing_decision,
      existing_outcome,
      true;
    return;
  end if;

  select * into reason_policy
  from companion_private.compute_reason_policies as policy
  where policy.reason_code = p_reason_code;

  if not found or reason_policy.billing_party <> p_billing_party then
    rejection_code := 'REASON_POLICY_MISMATCH';
  elsif p_estimated_input_tokens > reason_policy.max_input_tokens
    or p_max_output_tokens > reason_policy.max_output_tokens
    or p_reserved_cost_minor > reason_policy.max_reserved_cost_minor then
    rejection_code := 'REASON_CEILING_EXCEEDED';
  end if;

  select * into active_budget
  from public.compute_budgets as candidate
  where candidate.owner_id = p_owner_id
    and candidate.companion_id = p_companion_id
    and candidate.period_start <= now()
    and now() < candidate.period_end
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'active compute budget missing';
  end if;

  if p_retry_parent_transaction_id is not null and not exists (
    select 1 from public.compute_transactions as parent
    where parent.id = p_retry_parent_transaction_id and parent.owner_id = p_owner_id
  ) then
    raise exception using errcode = '23503', message = 'retry parent must belong to the same Owner';
  end if;

  if rejection_code is null and active_budget.currency <> p_currency then
    rejection_code := 'CURRENCY_MISMATCH';
  end if;

  if rejection_code is null and (
    active_budget.reserved_calls + active_budget.settled_calls + 1 > active_budget.max_model_calls
    or active_budget.reserved_input_tokens + active_budget.settled_input_tokens + p_estimated_input_tokens > active_budget.max_input_tokens
    or active_budget.reserved_output_tokens + active_budget.settled_output_tokens + p_max_output_tokens > active_budget.max_output_tokens
    or active_budget.reserved_cost_minor + active_budget.settled_cost_minor + p_reserved_cost_minor > active_budget.max_cost_minor
  ) then
    rejection_code := 'BUDGET_EXHAUSTED';
  end if;

  insert into public.compute_transactions (
    id, owner_id, companion_id, social_twin_id, reason_code, trigger_event_type, trigger_event_id,
    provider_id, credential_id, canonical_model, provider_model, billing_party, currency, pricing_version,
    prompt_template_version, identity_version, social_persona_version, memory_policy_version,
    safety_policy_version, router_version, trace_id, attempt_no, retry_parent_transaction_id,
    idempotency_key_hash, budget_id, request_hash, estimated_input_tokens, max_output_tokens, reserved_cost_minor
  ) values (
    new_transaction_id, p_owner_id, p_companion_id, p_social_twin_id, p_reason_code, p_trigger_event_type,
    p_trigger_event_id, p_provider_id, p_credential_id, p_canonical_model, p_provider_model, p_billing_party,
    p_currency, p_pricing_version, p_prompt_template_version, p_identity_version, p_social_persona_version,
    p_memory_policy_version, p_safety_policy_version, p_router_version, p_trace_id, p_attempt_no,
    p_retry_parent_transaction_id, p_idempotency_key_hash, active_budget.id, p_request_hash,
    p_estimated_input_tokens, p_max_output_tokens, p_reserved_cost_minor
  );

  if rejection_code is null then
    update public.compute_budgets
    set reserved_calls = reserved_calls + 1,
        reserved_input_tokens = reserved_input_tokens + p_estimated_input_tokens,
        reserved_output_tokens = reserved_output_tokens + p_max_output_tokens,
        reserved_cost_minor = reserved_cost_minor + p_reserved_cost_minor
    where id = active_budget.id;

    insert into public.compute_ledger_entries (
      owner_id, transaction_id, sequence, entry_type, status, input_tokens, output_tokens, reserved_cost_minor
    ) values (
      p_owner_id, new_transaction_id, 1, 'RESERVATION', 'RESERVED', p_estimated_input_tokens,
      p_max_output_tokens, p_reserved_cost_minor
    );

    return query select new_transaction_id, active_budget.id, 'RESERVED'::text, null::text, false;
  else
    insert into public.compute_ledger_entries (
      owner_id, transaction_id, sequence, entry_type, status, outcome_code
    ) values (
      p_owner_id, new_transaction_id, 1, 'REJECTION', 'REJECTED', rejection_code
    );

    return query select new_transaction_id, active_budget.id, 'REJECTED'::text, rejection_code, false;
  end if;
end;
$$;

revoke all on table companion_private.compute_reason_policies from public, anon, authenticated;
revoke all on function companion_private.reserve_compute_transaction(
  uuid, uuid, uuid, text, text, uuid, text, uuid, text, text, text, text, text, bigint, bigint, bigint,
  text, integer, integer, text, text, text, text, integer, uuid, text, text
) from public, anon, authenticated;
grant usage on schema companion_private to service_role;
grant execute on function companion_private.reserve_compute_transaction(
  uuid, uuid, uuid, text, text, uuid, text, uuid, text, text, text, text, text, bigint, bigint, bigint,
  text, integer, integer, text, text, text, text, integer, uuid, text, text
) to service_role;

comment on function companion_private.reserve_compute_transaction(
  uuid, uuid, uuid, text, text, uuid, text, uuid, text, text, text, text, text, bigint, bigint, bigint,
  text, integer, integer, text, text, text, text, integer, uuid, text, text
) is 'Atomically validates attribution, serializes idempotency, locks the active hard budget, and appends the first immutable ledger fact.';

commit;
