begin;

-- PostgreSQL's built-in function default grants EXECUTE to PUBLIC globally.
-- A schema-specific ALTER DEFAULT PRIVILEGES cannot subtract that global
-- default, so revoke it for the role that actually runs migrations. Future
-- server RPCs must opt their intended execution role in explicitly.
alter default privileges revoke execute on functions from public, anon, authenticated;

-- Remove inherited or direct client execution from functions that already
-- exist, while preserving explicit grants to service_role and the bounded
-- authenticated receipt query established by earlier migrations.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema companion_private from public, anon, authenticated;

-- Also remove any schema-specific client defaults configured for the current
-- migration creator. These entries are defense in depth after the global
-- PUBLIC default has been removed above.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema companion_private revoke execute on functions from public, anon, authenticated;

-- Restore the only authenticated RPC in the current persistence boundary.
-- Private transaction commands retain their existing explicit service_role
-- grants and are not exposed to browser or mobile client roles.
grant execute on function public.get_compute_receipt(uuid) to authenticated;

commit;
