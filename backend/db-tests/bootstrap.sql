create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
-- Supabase keeps pgcrypto in schema extensions, so public.digest does not exist there.
-- Migrations use the built-in sha256() instead; this keeps tests from passing on a public.digest.
create schema extensions;
create extension pgcrypto schema extensions;

create table auth.users (
  id uuid primary key,
  email varchar(255),
  banned_until timestamptz
);
-- One account per address, as on Supabase.
create unique index users_email_partial_key on auth.users(email);

-- How a user signs in. The sign-in service looks here first to tell whether an address is taken.
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'email',
  identity_data jsonb not null,
  email text generated always as (lower(identity_data->>'email')) stored
);

-- Supabase keeps one row per signed-in device; deleting it ends that sign-in.
create table auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema public to authenticated;
grant execute on function auth.uid() to authenticated;
alter default privileges in schema public grant select on tables to authenticated;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;
alter table storage.objects force row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant select on table storage.buckets to anon, authenticated, service_role;
grant select, insert, update, delete on table storage.objects to anon, authenticated, service_role;
