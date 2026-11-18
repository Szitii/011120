begin;

create extension if not exists btree_gist;

create table public.compute_budgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  max_model_calls integer not null check (max_model_calls >= 0),
  max_input_tokens bigint not null check (max_input_tokens >= 0),
  max_output_tokens bigint not null check (max_output_tokens >= 0),
  max_cost_minor bigint not null check (max_cost_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reserved_calls integer not null default 0 check (reserved_calls >= 0),
  settled_calls integer not null default 0 check (settled_calls >= 0),
  reserved_input_tokens bigint not null default 0 check (reserved_input_tokens >= 0),
  settled_input_tokens bigint not null default 0 check (settled_input_tokens >= 0),
  reserved_output_tokens bigint not null default 0 check (reserved_output_tokens >= 0),
  settled_output_tokens bigint not null default 0 check (settled_output_tokens >= 0),
  reserved_cost_minor bigint not null default 0 check (reserved_cost_minor >= 0),
  settled_cost_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  check (period_end > period_start),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  exclude using gist (owner_id with =, companion_id with =, tstzrange(period_start, period_end, '[)') with &&)
);

create table public.publication_budgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  max_publications integer not null check (max_publications >= 0),
  reserved_publications integer not null default 0 check (reserved_publications >= 0),
  consumed_publications integer not null default 0 check (consumed_publications >= 0),
  created_at timestamptz not null default now(),
  check (period_end > period_start),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  exclude using gist (owner_id with =, companion_id with =, tstzrange(period_start, period_end, '[)') with &&)
);

create table public.compute_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  social_twin_id uuid,
  reason_code text not null check (reason_code in ('IMPORT_IDENTITY_SUMMARY', 'MEMORY_CONSOLIDATION', 'OWNER_DIRECT_RESPONSE', 'SOCIAL_ENCOUNTER_RESPONSE', 'LIFE_EVENT_EXPRESSION', 'SAFETY_CLASSIFICATION', 'DLP_CLASSIFICATION')),
  trigger_event_type text not null,
  trigger_event_id uuid not null,
  provider_id text not null,
  credential_id uuid,
  canonical_model text not null,
  provider_model text not null,
  billing_party text not null check (billing_party in ('OWNER', 'PLATFORM', 'PROMOTION')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  pricing_version text not null,
  prompt_template_version text not null,
  identity_version integer not null check (identity_version > 0),
  social_persona_version integer,
  memory_policy_version text not null,
  safety_policy_version text not null,
  router_version text not null,
  trace_id text not null,
  attempt_no integer not null default 1 check (attempt_no > 0),
  retry_parent_transaction_id uuid references public.compute_transactions(id),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key_hash),
  unique (id, owner_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  foreign key (social_twin_id, owner_id) references public.social_twins(id, owner_id)
);

create table public.compute_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  transaction_id uuid not null,
  sequence integer not null check (sequence > 0),
  entry_type text not null check (entry_type in ('RESERVATION', 'REJECTION', 'START', 'SETTLEMENT', 'RELEASE', 'RECONCILIATION')),
  status text not null check (status in ('RESERVED', 'REJECTED', 'STARTED', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'RECONCILED')),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  reserved_cost_minor bigint not null default 0 check (reserved_cost_minor >= 0),
  actual_cost_minor bigint not null default 0 check (actual_cost_minor >= 0),
  cost_delta_minor bigint not null default 0,
  outcome_code text,
  provider_request_id_hash text,
  created_at timestamptz not null default now(),
  unique (transaction_id, sequence),
  foreign key (transaction_id, owner_id) references public.compute_transactions(id, owner_id)
);

create table public.publication_reservations (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references public.publication_budgets(id),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  related_event_id uuid not null,
  status text not null check (status in ('RESERVED', 'CONSUMED', 'RELEASED')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (companion_id, owner_id) references public.companions(id, owner_id)
);

create trigger compute_transactions_immutable
before update or delete on public.compute_transactions
for each row execute function companion_private.reject_immutable_mutation();

create trigger compute_ledger_entries_immutable
before update or delete on public.compute_ledger_entries
for each row execute function companion_private.reject_immutable_mutation();

alter table public.compute_budgets enable row level security;
alter table public.compute_budgets force row level security;
alter table public.publication_budgets enable row level security;
alter table public.publication_budgets force row level security;
alter table public.compute_transactions enable row level security;
alter table public.compute_transactions force row level security;
alter table public.compute_ledger_entries enable row level security;
alter table public.compute_ledger_entries force row level security;
alter table public.publication_reservations enable row level security;
alter table public.publication_reservations force row level security;

create policy compute_budgets_select_owned on public.compute_budgets
for select to authenticated using (exists (select 1 from public.owners where owners.id = compute_budgets.owner_id and owners.auth_user_id = (select auth.uid())));
create policy publication_budgets_select_owned on public.publication_budgets
for select to authenticated using (exists (select 1 from public.owners where owners.id = publication_budgets.owner_id and owners.auth_user_id = (select auth.uid())));
create policy compute_transactions_select_owned on public.compute_transactions
for select to authenticated using (exists (select 1 from public.owners where owners.id = compute_transactions.owner_id and owners.auth_user_id = (select auth.uid())));
create policy compute_ledger_entries_select_owned on public.compute_ledger_entries
for select to authenticated using (exists (select 1 from public.owners where owners.id = compute_ledger_entries.owner_id and owners.auth_user_id = (select auth.uid())));
create policy publication_reservations_select_owned on public.publication_reservations
for select to authenticated using (exists (select 1 from public.owners where owners.id = publication_reservations.owner_id and owners.auth_user_id = (select auth.uid())));

revoke insert, update, delete on public.compute_budgets from anon, authenticated;
revoke insert, update, delete on public.publication_budgets from anon, authenticated;
revoke insert, update, delete on public.compute_transactions from anon, authenticated;
revoke insert, update, delete on public.compute_ledger_entries from anon, authenticated;
revoke insert, update, delete on public.publication_reservations from anon, authenticated;

comment on table public.compute_transactions is 'Immutable attribution envelope. Prompt and completion bodies are prohibited.';
comment on table public.compute_ledger_entries is 'Append-only reservation, provider start, settlement, release, and reconciliation facts.';
comment on table public.publication_budgets is 'Independent public/delivery allowance; compute availability never implies publication.';

commit;
