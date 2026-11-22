begin;

-- The API server runs as companion_api, a role that has everything authenticated has.
-- Supabase's own REST API (/rest/v1/rpc) can only act as anon or authenticated, so a function
-- granted to companion_api alone is reachable through our server and not around it.
--
-- Only functions that trust work the server already did belong here:
--   create_companion_import  trusts that p_draft/p_findings came from the server's Import Firewall
--   claim_owner              trusts that the server rejected anonymous Supabase users
-- Every other RPC checks its own input in SQL and stays callable by authenticated.
--
-- The database login the API server uses must be a member of companion_api. This migration
-- grants it to the role that runs migrations; grant it to the API login too if that differs.
do $$ begin create role companion_api nologin; exception when duplicate_object then null; end $$;
grant authenticated to companion_api;
grant companion_api to current_user;

revoke execute on function public.create_companion_import(text,text,integer,text,text,text,jsonb,jsonb,text,text),
  public.claim_owner() from authenticated;
grant execute on function public.create_companion_import(text,text,integer,text,text,text,jsonb,jsonb,text,text),
  public.claim_owner() to companion_api;

commit;
