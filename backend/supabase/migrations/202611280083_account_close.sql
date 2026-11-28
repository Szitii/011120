begin;

-- Closing one's own account (账号注销): DELETE /v0/account
--
-- Decided by the product owner on 2026-11-27: the data is kept on file, the sign-in stops
-- working. So nothing is erased here. The Owner becomes DELETED, the state the schema has had
-- since 0001 and that every function already treats like SUSPENDED:
--   - every request is refused (claim_owner answers null);
--   - nobody sees the account any more: profiles, posts and comments of the person and of their
--     Companions drop out of the community (community_profile_available);
--   - nothing runs for it: no greeting, no reminder, no diary, no post written by a Companion,
--     and the Owner's agent keys stop working.
-- Four things are done on top of the state:
--   - the keys the Owner stored with us are destroyed (their own model keys, their agent's
--     address and token, the keys their agent checks in with): a secret is not something to keep
--     on file;
--   - the sign-in is banned and its sessions are ended, so no new token is issued. A token
--     already issued (an hour at most) is refused by this server at once; Storage still lets it
--     fetch its own files until it runs out;
--   - the time is written down (owners.closed_at) for whoever later decides how long a closed
--     account stays on file;
--   - the e-mail address is given back (decided 2026-11-28): the same address can sign up again
--     and gets a new, empty account; nothing of the closed one comes with it. The sign-in service
--     calls an address taken when it finds it in auth.identities or in auth.users (its
--     IsDuplicatedEmail), so the closed sign-in keeps its address in both with a mark behind it:
--     a@b.c becomes a@b.c.closed-<user id>.invalid. Whoever reads the address (the operator
--     console, its search by e-mail) still finds the account and sees that it is closed.
-- There is no way back from the app: reopening an account is an operator's job, by hand (status
-- ACTIVE, banned_until null, the mark taken off in both places, which only works while nobody
-- has signed up with the address again), and the destroyed keys stay gone.
--
-- Only the API server may call it: the server first makes sure the caller typed their password
-- within the last few minutes, which the database cannot see.

-- The function below changes rows of the sign-in service as its owner, whoever runs this migration.
do $$ begin
  if not has_table_privilege(current_user, 'auth.users', 'UPDATE')
    or not has_table_privilege(current_user, 'auth.identities', 'UPDATE')
    or not has_table_privilege(current_user, 'auth.sessions', 'DELETE')
    or not (select rolsuper or rolbypassrls from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'this migration must be run by a role that can change every row of auth.users, auth.identities and auth.sessions';
  end if;
end $$;

alter table public.owners add column closed_at timestamptz;

create function public.account_close()
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); uid uuid := (select auth.uid());
  -- No mail ever reaches '.invalid'; the id keeps two closed accounts of one address apart.
  mark text := '.closed-' || replace(uid::text, '-', '') || '.invalid';
begin
  -- The update is the lock (the kind every other writer takes on an Owner: audit rows written for
  -- this Owner meanwhile are not held up). Of two requests at once, the second finds it closed.
  update public.owners set status = 'DELETED', closed_at = now(), updated_at = now() where id = o and status = 'ACTIVE';
  if not found then raise exception using errcode='42501', message='authentication required'; end if;
  delete from companion_private.companion_connections x using public.companions c
    where c.id = x.companion_id and c.owner_id = o;
  delete from companion_private.agent_keys where owner_id = o;
  -- A date far away rather than 'infinity', which the sign-in service may not read. The address
  -- column holds 255 characters: one too long to take the mark loses its end rather than the close.
  update auth.users set banned_until = now() + interval '100 years',
    email = left(email, 255 - char_length(mark)) || mark where id = uid;
  -- Closed here but still able to sign in would be the worst of both: undo everything instead.
  if not found then raise exception using errcode='XX000', message='the sign-in could not be banned'; end if;
  update auth.identities set identity_data = jsonb_set(identity_data, '{email}',
      to_jsonb(left(identity_data->>'email', 255 - char_length(mark)) || mark))
    where user_id = uid and identity_data->>'email' is not null;
  delete from auth.sessions where user_id = uid;
  insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
    values (o, 'OWNER', o, 'ACCOUNT_CLOSE', 'OWNER', o);
  return jsonb_build_object('closed', true);
end $$;

revoke all on function public.account_close() from public, anon, authenticated;
grant execute on function public.account_close() to companion_api;

insert into companion_private.schema_migrations(name) values ('202611280083_account_close');

commit;
