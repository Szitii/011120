begin;

revoke all on schema companion_private from public, anon, authenticated;

create table public.social_handles (
  handle text primary key check (handle ~ '^[a-z0-9_]{3,30}$'),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  created_at timestamptz not null default now(),
  unique (companion_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id)
);

create table public.social_personas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  version integer not null check (version > 0),
  handle text not null references public.social_handles(handle),
  display_name text not null check (char_length(display_name) between 1 and 200),
  public_document jsonb not null,
  profile_visibility text not null check (profile_visibility in ('PRIVATE', 'FRIENDS', 'PUBLIC')),
  source_identity_version_id uuid not null,
  source_identity_content_hash text not null check (source_identity_content_hash ~ '^[a-f0-9]{64}$'),
  projection_manifest jsonb not null check (jsonb_typeof(projection_manifest) = 'array'),
  supersedes_social_persona_id uuid,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  approved_by_owner_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (companion_id, version),
  unique (id, companion_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  foreign key (source_identity_version_id, companion_id) references public.companion_identities(id, companion_id),
  foreign key (supersedes_social_persona_id, companion_id) references public.social_personas(id, companion_id)
);

create table public.social_twins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null unique,
  active_social_persona_id uuid not null,
  status text not null check (status in ('ACTIVE', 'LIMITED', 'SUSPENDED')),
  autonomy_mode text not null check (autonomy_mode in ('QUIET', 'NORMAL', 'ACTIVE', 'CUSTOM')),
  social_memory_namespace_id uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  foreign key (active_social_persona_id, companion_id) references public.social_personas(id, companion_id)
);

create table companion_private.memory_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  namespace text not null check (namespace in ('PRIVATE', 'SOCIAL')),
  domain text not null check (domain in ('OWNER_ONLY', 'COMPANION_PRIVATE', 'RELATIONSHIP_PRIVATE', 'FRIEND_SHAREABLE', 'SOCIAL', 'PUBLIC')),
  source_trust text not null check (source_trust in ('OWNER_ASSERTED', 'PLATFORM_EVENT', 'MODEL_DERIVED', 'EXTERNAL_UNTRUSTED')),
  content_ciphertext bytea,
  content_plaintext text,
  summary text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  valid_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  check ((content_ciphertext is null) <> (content_plaintext is null)),
  check (
    (namespace = 'PRIVATE' and domain in ('OWNER_ONLY', 'COMPANION_PRIVATE', 'RELATIONSHIP_PRIVATE'))
    or
    (namespace = 'SOCIAL' and domain in ('FRIEND_SHAREABLE', 'SOCIAL', 'PUBLIC'))
  )
);

create table companion_private.memory_permissions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  memory_id uuid not null,
  effect text not null check (effect in ('ALLOW', 'DENY')),
  grantee_type text not null check (grantee_type in ('COMPANION_PRIVATE_RUNTIME', 'SOCIAL_TWIN', 'FRIENDSHIP')),
  grantee_id uuid not null,
  purpose text not null check (purpose in ('PRIVATE_CHAT', 'SOCIAL_POST', 'COMMENT_REPLY', 'DM', 'PROFILE', 'LIFE_EVENT', 'EXPORT')),
  max_disclosure text not null check (max_disclosure in ('PRESENCE_ONLY', 'SUMMARY', 'FULL')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (memory_id, owner_id) references companion_private.memory_records(id, owner_id)
);

create table public.memory_access_receipts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  principal_type text not null check (principal_type in ('PRIVATE_COMPANION_RUNTIME', 'SOCIAL_TWIN')),
  principal_id uuid not null,
  purpose text not null,
  policy_version text not null,
  context_hash text not null check (context_hash ~ '^[a-f0-9]{64}$'),
  decisions jsonb not null check (jsonb_typeof(decisions) = 'array'),
  created_at timestamptz not null default now(),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id)
);

create trigger social_personas_immutable
before update or delete on public.social_personas
for each row execute function companion_private.reject_immutable_mutation();

create trigger memory_access_receipts_immutable
before update or delete on public.memory_access_receipts
for each row execute function companion_private.reject_immutable_mutation();

alter table public.social_handles enable row level security;
alter table public.social_handles force row level security;
alter table public.social_personas enable row level security;
alter table public.social_personas force row level security;
alter table public.social_twins enable row level security;
alter table public.social_twins force row level security;
alter table public.memory_access_receipts enable row level security;
alter table public.memory_access_receipts force row level security;

create policy social_handles_select_owned on public.social_handles
for select to authenticated
using (exists (select 1 from public.owners where owners.id = social_handles.owner_id and owners.auth_user_id = (select auth.uid())));

create policy social_personas_select_owned on public.social_personas
for select to authenticated
using (exists (select 1 from public.owners where owners.id = social_personas.owner_id and owners.auth_user_id = (select auth.uid())));

create policy social_twins_select_owned on public.social_twins
for select to authenticated
using (exists (select 1 from public.owners where owners.id = social_twins.owner_id and owners.auth_user_id = (select auth.uid())));

create policy memory_access_receipts_select_owned on public.memory_access_receipts
for select to authenticated
using (exists (select 1 from public.owners where owners.id = memory_access_receipts.owner_id and owners.auth_user_id = (select auth.uid())));

revoke insert, update, delete on public.social_handles from anon, authenticated;
revoke insert, update, delete on public.social_personas from anon, authenticated;
revoke insert, update, delete on public.social_twins from anon, authenticated;
revoke insert, update, delete on public.memory_access_receipts from anon, authenticated;

comment on table public.social_personas is 'Immutable Owner-approved public projections. Contains no implicit memory authority.';
comment on table public.social_twins is 'Social runtime principals with a SOCIAL-only memory namespace.';
comment on table companion_private.memory_records is 'Permission-gated memory truth. Descriptor authorization must precede content or embedding retrieval.';
comment on table public.memory_access_receipts is 'Owner-visible policy decisions without memory content.';

commit;
