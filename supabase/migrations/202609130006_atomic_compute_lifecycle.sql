begin;

create or replace function companion_private.start_compute_transaction(
  p_owner_id uuid,
  p_transaction_id uuid
)
returns table (
  ledger_entry_id uuid,
  ledger_sequence integer,
  decision text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  compute_transaction public.compute_transactions%rowtype;
  latest_entry public.compute_ledger_entries%rowtype;
  new_entry_id uuid := gen_random_uuid();
begin
  select * into compute_transaction
  from public.compute_transactions as candidate
  where candidate.id = p_transaction_id and candidate.owner_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'compute transaction not found for Owner';
  end if;

  select * into latest_entry
  from public.compute_ledger_entries as entry
  where entry.transaction_id = p_transaction_id
  order by entry.sequence desc
  limit 1;

  if latest_entry.status = 'STARTED' then
    return query select latest_entry.id, latest_entry.sequence, latest_entry.status, true;
    return;
  end if;

  if latest_entry.entry_type <> 'RESERVATION' or latest_entry.status <> 'RESERVED' then
    raise exception using errcode = '55000', message = 'only a reserved compute transaction may start';
  end if;

  insert into public.compute_ledger_entries (
    id, owner_id, transaction_id, sequence, entry_type, status
  ) values (
    new_entry_id, p_owner_id, p_transaction_id, latest_entry.sequence + 1, 'START', 'STARTED'
  );

  return query select new_entry_id, latest_entry.sequence + 1, 'STARTED'::text, false;
end;
$$;

create or replace function companion_private.settle_compute_transaction(
  p_owner_id uuid,
  p_transaction_id uuid,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_actual_cost_minor bigint,
  p_status text,
  p_outcome_code text,
  p_provider_request_id_hash text
)
returns table (
  ledger_entry_id uuid,
  ledger_sequence integer,
  decision text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  compute_transaction public.compute_transactions%rowtype;
  active_budget public.compute_budgets%rowtype;
  latest_entry public.compute_ledger_entries%rowtype;
  new_entry_id uuid := gen_random_uuid();
begin
  if p_input_tokens is null or p_input_tokens < 0
    or p_output_tokens is null or p_output_tokens < 0
    or p_actual_cost_minor is null or p_actual_cost_minor < 0
    or p_status not in ('SUCCEEDED', 'FAILED', 'BLOCKED')
    or (p_provider_request_id_hash is not null and p_provider_request_id_hash !~ '^[a-f0-9]{64}$') then
    raise exception using errcode = '22023', message = 'invalid compute settlement';
  end if;

  select * into compute_transaction
  from public.compute_transactions as candidate
  where candidate.id = p_transaction_id and candidate.owner_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'compute transaction not found for Owner';
  end if;

  if compute_transaction.budget_id is null
    or compute_transaction.estimated_input_tokens is null
    or compute_transaction.max_output_tokens is null
    or compute_transaction.reserved_cost_minor is null then
    raise exception using errcode = '55000', message = 'compute transaction lacks durable reservation metadata';
  end if;

  select * into latest_entry
  from public.compute_ledger_entries as entry
  where entry.transaction_id = p_transaction_id
  order by entry.sequence desc
  limit 1;

  if latest_entry.status in ('SUCCEEDED', 'FAILED', 'BLOCKED') then
    if latest_entry.status = p_status
      and latest_entry.input_tokens = p_input_tokens
      and latest_entry.output_tokens = p_output_tokens
      and latest_entry.actual_cost_minor = p_actual_cost_minor
      and latest_entry.outcome_code is not distinct from p_outcome_code
      and latest_entry.provider_request_id_hash is not distinct from p_provider_request_id_hash then
      return query select latest_entry.id, latest_entry.sequence, latest_entry.status, true;
      return;
    end if;
    raise exception using errcode = '23505', message = 'compute settlement replay does not match the terminal ledger fact';
  end if;

  if latest_entry.entry_type <> 'START' or latest_entry.status <> 'STARTED' then
    raise exception using errcode = '55000', message = 'only a started compute transaction may settle';
  end if;

  select * into active_budget
  from public.compute_budgets as candidate
  where candidate.id = compute_transaction.budget_id
    and candidate.owner_id = p_owner_id
    and candidate.companion_id = compute_transaction.companion_id
  for update;

  if not found then
    raise exception using errcode = '55000', message = 'reserved compute budget is missing';
  end if;

  if active_budget.reserved_calls < 1
    or active_budget.reserved_input_tokens < compute_transaction.estimated_input_tokens
    or active_budget.reserved_output_tokens < compute_transaction.max_output_tokens
    or active_budget.reserved_cost_minor < compute_transaction.reserved_cost_minor then
    raise exception using errcode = '55000', message = 'compute reservation counters are inconsistent';
  end if;

  update public.compute_budgets
  set reserved_calls = reserved_calls - 1,
      settled_calls = settled_calls + 1,
      reserved_input_tokens = reserved_input_tokens - compute_transaction.estimated_input_tokens,
      settled_input_tokens = settled_input_tokens + p_input_tokens,
      reserved_output_tokens = reserved_output_tokens - compute_transaction.max_output_tokens,
      settled_output_tokens = settled_output_tokens + p_output_tokens,
      reserved_cost_minor = reserved_cost_minor - compute_transaction.reserved_cost_minor,
      settled_cost_minor = settled_cost_minor + p_actual_cost_minor
  where id = active_budget.id;

  insert into public.compute_ledger_entries (
    id, owner_id, transaction_id, sequence, entry_type, status, input_tokens, output_tokens,
    actual_cost_minor, outcome_code, provider_request_id_hash
  ) values (
    new_entry_id, p_owner_id, p_transaction_id, latest_entry.sequence + 1, 'SETTLEMENT', p_status,
    p_input_tokens, p_output_tokens, p_actual_cost_minor, p_outcome_code, p_provider_request_id_hash
  );

  return query select new_entry_id, latest_entry.sequence + 1, p_status, false;
end;
$$;

create or replace function companion_private.release_compute_transaction(
  p_owner_id uuid,
  p_transaction_id uuid,
  p_outcome_code text
)
returns table (
  ledger_entry_id uuid,
  ledger_sequence integer,
  decision text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  compute_transaction public.compute_transactions%rowtype;
  active_budget public.compute_budgets%rowtype;
  latest_entry public.compute_ledger_entries%rowtype;
  new_entry_id uuid := gen_random_uuid();
begin
  if p_outcome_code is null or btrim(p_outcome_code) = '' then
    raise exception using errcode = '22023', message = 'release outcome code is required';
  end if;

  select * into compute_transaction
  from public.compute_transactions as candidate
  where candidate.id = p_transaction_id and candidate.owner_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'compute transaction not found for Owner';
  end if;

  if compute_transaction.budget_id is null
    or compute_transaction.estimated_input_tokens is null
    or compute_transaction.max_output_tokens is null
    or compute_transaction.reserved_cost_minor is null then
    raise exception using errcode = '55000', message = 'compute transaction lacks durable reservation metadata';
  end if;

  select * into latest_entry
  from public.compute_ledger_entries as entry
  where entry.transaction_id = p_transaction_id
  order by entry.sequence desc
  limit 1;

  if latest_entry.entry_type = 'RELEASE' and latest_entry.status = 'CANCELLED' then
    if latest_entry.outcome_code = p_outcome_code then
      return query select latest_entry.id, latest_entry.sequence, latest_entry.status, true;
      return;
    end if;
    raise exception using errcode = '23505', message = 'compute release replay does not match the terminal ledger fact';
  end if;

  if latest_entry.entry_type <> 'RESERVATION' or latest_entry.status <> 'RESERVED' then
    raise exception using errcode = '55000', message = 'only a reservation not sent to a provider may be released';
  end if;

  select * into active_budget
  from public.compute_budgets as candidate
  where candidate.id = compute_transaction.budget_id
    and candidate.owner_id = p_owner_id
    and candidate.companion_id = compute_transaction.companion_id
  for update;

  if not found then
    raise exception using errcode = '55000', message = 'reserved compute budget is missing';
  end if;

  if active_budget.reserved_calls < 1
    or active_budget.reserved_input_tokens < compute_transaction.estimated_input_tokens
    or active_budget.reserved_output_tokens < compute_transaction.max_output_tokens
    or active_budget.reserved_cost_minor < compute_transaction.reserved_cost_minor then
    raise exception using errcode = '55000', message = 'compute reservation counters are inconsistent';
  end if;

  update public.compute_budgets
  set reserved_calls = reserved_calls - 1,
      reserved_input_tokens = reserved_input_tokens - compute_transaction.estimated_input_tokens,
      reserved_output_tokens = reserved_output_tokens - compute_transaction.max_output_tokens,
      reserved_cost_minor = reserved_cost_minor - compute_transaction.reserved_cost_minor
  where id = active_budget.id;

  insert into public.compute_ledger_entries (
    id, owner_id, transaction_id, sequence, entry_type, status, outcome_code
  ) values (
    new_entry_id, p_owner_id, p_transaction_id, latest_entry.sequence + 1, 'RELEASE', 'CANCELLED', p_outcome_code
  );

  return query select new_entry_id, latest_entry.sequence + 1, 'CANCELLED'::text, false;
end;
$$;

revoke all on function companion_private.start_compute_transaction(uuid, uuid) from public, anon, authenticated;
revoke all on function companion_private.settle_compute_transaction(uuid, uuid, bigint, bigint, bigint, text, text, text) from public, anon, authenticated;
revoke all on function companion_private.release_compute_transaction(uuid, uuid, text) from public, anon, authenticated;
grant execute on function companion_private.start_compute_transaction(uuid, uuid) to service_role;
grant execute on function companion_private.settle_compute_transaction(uuid, uuid, bigint, bigint, bigint, text, text, text) to service_role;
grant execute on function companion_private.release_compute_transaction(uuid, uuid, text) to service_role;

comment on function companion_private.start_compute_transaction(uuid, uuid) is 'Appends START exactly once immediately before provider I/O.';
comment on function companion_private.settle_compute_transaction(uuid, uuid, bigint, bigint, bigint, text, text, text) is 'Atomically settles actual usage and moves reserved Compute counters to settled counters.';
comment on function companion_private.release_compute_transaction(uuid, uuid, text) is 'Atomically releases a Compute reservation that has not started provider I/O.';

commit;
