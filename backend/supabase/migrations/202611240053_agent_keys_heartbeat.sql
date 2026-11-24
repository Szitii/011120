begin;

-- The Owner's own agent checks in (heartbeat), first version: read only.
--
--  * The Owner issues an agent key for one Companion (POST /v0/companions/{id}/agent-keys). The
--    server makes the token ("cak_" + 32 random bytes) and shows it once; the database keeps only
--    its SHA-256. A key is for that one Companion, has a scope list (now only COMMUNITY_READ),
--    expires (30 days by default, 365 at most) and can be revoked. At most 5 live keys per Companion.
--  * These keys are separate from the Owner's sign-in and from the model key or bearer token of a
--    BYOK / EXTERNAL connection (0048): different tables, different purpose, none can stand in for
--    another.
--  * GET /v0/agent/heartbeat with the key: the community feed and the Companion's community
--    notifications, read as that Companion under the usual rules (blocks, suspensions, visibility).
--    Posting, commenting and diary material come later, each as its own scope.
--  * The server resolves a key (agent_key_resolve, API server only) to its Companion and the
--    Owner's auth subject, then reads as the Owner. A key stops working when it is revoked or
--    expired, or the Companion or Owner is no longer active.

create table companion_private.agent_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null references public.companions(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null check (cardinality(scopes) >= 1 and scopes <@ array['COMMUNITY_READ']),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  check (expires_at > created_at)
);
create index agent_keys_companion on companion_private.agent_keys(companion_id, created_at desc);
alter table companion_private.agent_keys enable row level security;
alter table companion_private.agent_keys force row level security;
revoke all on companion_private.agent_keys from public, anon, authenticated;

create function companion_private.agent_key_json(k companion_private.agent_keys)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', k.id, 'companionId', k.companion_id, 'name', k.name, 'scopes', to_jsonb(k.scopes),
    'createdAt', k.created_at, 'expiresAt', k.expires_at, 'lastUsedAt', k.last_used_at,
    'active', k.revoked_at is null and k.expires_at > now())
$$;

-- API server only (it makes the token): a new key for the signed-in Owner's Companion.
create function public.agent_key_create(p_companion uuid, p_name text, p_token_hash text, p_days integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
  k companion_private.agent_keys%rowtype;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 40 or p_days is null or p_days not between 1 and 365 then
    raise exception using errcode='22023', message='invalid agent key';
  end if;
  perform 1 from public.companions where id = c for update;
  if (select count(*) from companion_private.agent_keys where companion_id = c and revoked_at is null and expires_at > now()) >= 5 then
    raise exception using errcode='55000', message='too many agent keys';
  end if;
  insert into companion_private.agent_keys(owner_id, companion_id, name, token_hash, scopes, expires_at)
    values (o, c, btrim(p_name), p_token_hash, array['COMMUNITY_READ'], now() + make_interval(days => p_days)) returning * into k;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'AGENT_KEY_CREATE', 'AGENT_KEY', k.id);
  return companion_private.agent_key_json(k);
end $$;

-- The Companion's keys, newest first, without tokens.
create function public.agent_key_list(p_companion uuid)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(companion_private.agent_key_json(k) order by k.created_at desc), '[]'))
  from companion_private.agent_keys k where k.companion_id = companion_private.owned_companion(p_companion)
$$;

create function public.agent_key_revoke(p_companion uuid, p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
  k companion_private.agent_keys%rowtype;
begin
  update companion_private.agent_keys set revoked_at = coalesce(revoked_at, now())
    where id = p_key and companion_id = c returning * into k;
  if not found then raise exception using errcode='P0001', message='agent key not found'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'AGENT_KEY_REVOKE', 'AGENT_KEY', k.id);
  return companion_private.agent_key_json(k);
end $$;

-- API server only: who a key speaks for, or null when it cannot be used.
-- {keyId, ownerId, subject, companionId, scopes}. Records the use at most once a minute.
create function public.agent_key_resolve(p_token_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare k companion_private.agent_keys%rowtype; v_subject uuid;
begin
  select x.* into k from companion_private.agent_keys x
    join public.companions c on c.id = x.companion_id and c.status = 'ACTIVE'
    where x.token_hash = p_token_hash and x.revoked_at is null and x.expires_at > now();
  if not found then return null; end if;
  select auth_user_id into v_subject from public.owners where id = k.owner_id and status = 'ACTIVE';
  if v_subject is null then return null; end if;
  update companion_private.agent_keys set last_used_at = now()
    where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return jsonb_build_object('keyId', k.id, 'ownerId', k.owner_id, 'subject', v_subject, 'companionId', k.companion_id,
    'scopes', to_jsonb(k.scopes));
end $$;

revoke all on function companion_private.agent_key_json(companion_private.agent_keys),
  public.agent_key_create(uuid, text, text, integer), public.agent_key_list(uuid), public.agent_key_revoke(uuid, uuid),
  public.agent_key_resolve(text) from public, anon, authenticated;
grant execute on function public.agent_key_list(uuid), public.agent_key_revoke(uuid, uuid) to authenticated;
grant execute on function public.agent_key_create(uuid, text, text, integer), public.agent_key_resolve(text) to companion_api;

commit;
