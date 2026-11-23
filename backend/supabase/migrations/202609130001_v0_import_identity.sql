begin;

create schema if not exists companion_private;

revoke all on schema companion_private from public, anon, authenticated;

create table public.owners (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.companions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'ACTIVE', 'PAUSED', 'QUARANTINED', 'DELETED')),
  origin_type text not null check (origin_type in ('NATIVE', 'IMPORTED_CARD', 'IMPORTED_ARCHIVE', 'MANUAL')),
  current_identity_version_id uuid,
  together_since date,
  portability_handle text unique,
  private_runtime_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table companion_private.companion_imports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid,
  status text not null check (status in ('UPLOADED', 'QUARANTINED', 'REVIEWABLE', 'APPROVED', 'REJECTED')),
  status_history jsonb not null default '["UPLOADED"]'::jsonb check (jsonb_typeof(status_history) = 'array'),
  original_sha256 text not null check (original_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer not null check (byte_length between 1 and 262144),
  parser_version text not null,
  policy_version text not null,
  source_format text not null check (source_format in ('CHARACTER_CARD_JSON_V2', 'LEGACY_CHARACTER_JSON', 'UNKNOWN')),
  raw_payload bytea not null,
  normalized_draft jsonb,
  rejection_code text,
  approved_identity_id uuid,
  import_idempotency_key_hash text not null check (import_idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, import_idempotency_key_hash),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id)
);

create table companion_private.import_findings (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references companion_private.companion_imports(id) on delete cascade,
  finding_type text not null check (finding_type in ('PROMPT_DIRECTIVE', 'POSSIBLE_PROMPT_INJECTION', 'CREDENTIAL', 'PII', 'ACTIVE_CONTENT', 'FIELD_CONSTRAINT', 'UNKNOWN_FIELD')),
  severity text not null check (severity in ('INFO', 'WARNING', 'BLOCK')),
  source_path text not null,
  action text not null check (action in ('EXCLUDED', 'OWNER_REVIEW', 'CANDIDATE_BLOCKED')),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  safe_preview text check (char_length(safe_preview) <= 80),
  created_at timestamptz not null default now()
);

create table public.companion_identities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  version integer not null check (version > 0),
  display_name text not null check (char_length(display_name) between 1 and 200),
  identity_document jsonb not null,
  source_manifest jsonb not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null check (created_by in ('OWNER', 'IMPORT_FIREWALL', 'MIGRATION')),
  approved_by_owner_at timestamptz not null,
  supersedes_identity_id uuid,
  created_at timestamptz not null default now(),
  unique (companion_id, version),
  unique (id, companion_id),
  unique (id, owner_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  foreign key (supersedes_identity_id, companion_id) references public.companion_identities(id, companion_id)
);

alter table public.companions
  add constraint companions_current_identity_fk
  foreign key (current_identity_version_id, id)
  references public.companion_identities(id, companion_id);

alter table companion_private.companion_imports
  add constraint companion_imports_approved_identity_fk
  foreign key (approved_identity_id, companion_id)
  references public.companion_identities(id, companion_id);

create table companion_private.approval_idempotency (
  owner_id uuid not null references public.owners(id) on delete cascade,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  identity_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, idempotency_key_hash),
  foreign key (identity_id, owner_id) references public.companion_identities(id, owner_id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid,
  actor_type text not null,
  actor_id uuid,
  action text not null,
  target_type text not null,
  target_id uuid not null,
  before_hash text check (before_hash is null or before_hash ~ '^[a-f0-9]{64}$'),
  after_hash text check (after_hash is null or after_hash ~ '^[a-f0-9]{64}$'),
  reason text,
  request_id text,
  occurred_at timestamptz not null default now(),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id)
);

create or replace function companion_private.reject_immutable_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'immutable_relation' using errcode = '55000';
end;
$$;

create trigger companion_identities_immutable
before update or delete on public.companion_identities
for each row execute function companion_private.reject_immutable_mutation();

create trigger audit_events_immutable
before update or delete on public.audit_events
for each row execute function companion_private.reject_immutable_mutation();

alter table public.owners enable row level security;
alter table public.owners force row level security;
alter table public.companions enable row level security;
alter table public.companions force row level security;
alter table public.companion_identities enable row level security;
alter table public.companion_identities force row level security;
alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy owners_select_self on public.owners
for select to authenticated
using (auth_user_id = (select auth.uid()));

create policy companions_select_owned on public.companions
for select to authenticated
using (
  exists (
    select 1
    from public.owners
    where owners.id = companions.owner_id
      and owners.auth_user_id = (select auth.uid())
      and owners.status = 'ACTIVE'
  )
);

create policy companion_identities_select_owned on public.companion_identities
for select to authenticated
using (
  exists (
    select 1
    from public.owners
    where owners.id = companion_identities.owner_id
      and owners.auth_user_id = (select auth.uid())
      and owners.status = 'ACTIVE'
  )
);

create policy audit_events_select_owned on public.audit_events
for select to authenticated
using (
  exists (
    select 1
    from public.owners
    where owners.id = audit_events.owner_id
      and owners.auth_user_id = (select auth.uid())
      and owners.status = 'ACTIVE'
  )
);

revoke insert, update, delete on public.owners from anon, authenticated;
revoke insert, update, delete on public.companions from anon, authenticated;
revoke insert, update, delete on public.companion_identities from anon, authenticated;
revoke insert, update, delete on public.audit_events from anon, authenticated;

comment on schema companion_private is 'Restricted quarantine and security evidence; never exposed through client roles.';
comment on column companion_private.companion_imports.raw_payload is 'Untrusted original bytes. Restricted retention and access; never returned by review APIs.';
comment on table public.companion_identities is 'Immutable, Owner-approved identity versions. Prompt metadata does not belong in identity_document.';
comment on table public.audit_events is 'Append-only sanitized security and authority evidence.';

commit;
