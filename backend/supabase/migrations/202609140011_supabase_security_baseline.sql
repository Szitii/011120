begin;

-- Supabase grants broad privileges to API roles by default. Replace those
-- implicit grants with the narrow read surface protected by Owner-scoped RLS.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant select on table
  public.owners,
  public.companions,
  public.companion_identities,
  public.audit_events,
  public.social_handles,
  public.social_personas,
  public.social_twins,
  public.memory_access_receipts,
  public.compute_budgets,
  public.publication_budgets,
  public.compute_transactions,
  public.compute_ledger_entries,
  public.publication_reservations,
  public.encounter_invitations,
  public.encounter_artifacts,
  public.life_events,
  public.life_event_inbox
to authenticated;

grant execute on function public.get_compute_receipt(uuid) to authenticated;

revoke all on all tables in schema companion_private from public, anon, authenticated;
revoke all on all sequences in schema companion_private from public, anon, authenticated;
revoke execute on all functions in schema companion_private from public, anon, authenticated;
revoke all on schema companion_private from public, anon, authenticated;

-- New relations and functions must be explicitly exposed by their migration.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema companion_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema companion_private revoke all on sequences from public, anon, authenticated;
alter default privileges in schema companion_private revoke execute on functions from public, anon, authenticated;

-- JSON imports remain backend-only quarantine objects. There is intentionally
-- no anon/authenticated policy: browser and mobile clients cannot enumerate,
-- upload, replace, or delete quarantine payloads directly.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'companion-import-quarantine',
  'companion-import-quarantine',
  false,
  262144,
  array['application/json']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy companion_import_quarantine_service_only
on storage.objects
for all
to service_role
using (bucket_id = 'companion-import-quarantine')
with check (bucket_id = 'companion-import-quarantine');

comment on policy companion_import_quarantine_service_only on storage.objects
is 'Backend-only bounded JSON quarantine. Client upload and object visibility remain denied until an authenticated command adapter exists.';

commit;
