begin;

-- First sign-in creates the Owner row for a verified Supabase user.
-- Who may sign up at all is controlled in Supabase Auth (disable public sign-ups, invite by email),
-- so no separate allowlist is kept here. Returns null for a SUSPENDED or DELETED Owner:
-- an existing account is never re-activated by signing in again.
create function public.claim_owner()
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid := (select auth.uid()); owner_id uuid; owner_status text;
begin
  if uid is null then raise exception using errcode='42501', message='authentication required'; end if;
  insert into public.owners(auth_user_id) values (uid) on conflict (auth_user_id) do nothing;
  select id, status into owner_id, owner_status from public.owners where auth_user_id = uid;
  return case when owner_status = 'ACTIVE' then owner_id end;
end $$;

revoke all on function public.claim_owner() from public, anon;
grant execute on function public.claim_owner() to authenticated;

commit;
