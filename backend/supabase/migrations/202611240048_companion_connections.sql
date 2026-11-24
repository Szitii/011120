begin;

-- How a Companion speaks (家机接入方式). No row: the platform's models (the default).
--   BYOK      the Owner's own API key for an OpenAI-compatible provider; the platform still
--             writes the prompt (persona, memories, chat rules) and the platform pays nothing.
--   EXTERNAL  the Owner's own agent (Dify, Coze, OpenClaw, a personal server): an HTTPS endpoint
--             that answers in the OpenAI /chat/completions format, with an optional bearer token.
-- Either way the reply passes the same output safety scan and is kept in the chat like any other.
--
-- The key or token is sealed by the API server (AES-256-GCM, bound to the Companion) before it
-- reaches the database, so the database, backups and operators only see ciphertext. Only the
-- API server can read it back (connection_secret, granted to companion_api alone); the Owner
-- sees the last 4 characters. Saving is server-only too, because the server tests the
-- connection first and only saves one that answered.

create table companion_private.companion_connections (
  companion_id uuid primary key references public.companions(id) on delete cascade,
  kind text not null check (kind in ('BYOK', 'EXTERNAL')),
  -- BYOK: a preset provider (deepseek, qwen, ...) or 'custom'. EXTERNAL: null.
  provider text check (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- BYOK: the provider's API base. EXTERNAL: the full endpoint URL.
  base_url text not null check (char_length(base_url) <= 500 and base_url ~ '^https://[^\s?#@]+$'),
  model text check (char_length(model) between 1 and 120),
  -- EXTERNAL: the name the Owner gave it.
  name text check (char_length(name) between 1 and 40),
  secret text not null check (secret ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'),
  secret_hint text not null check (char_length(secret_hint) <= 4),
  consented_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check ((kind = 'BYOK') = (provider is not null)),
  check (kind <> 'BYOK' or model is not null),
  check (kind <> 'EXTERNAL' or name is not null)
);
alter table companion_private.companion_connections enable row level security;
alter table companion_private.companion_connections force row level security;
revoke all on companion_private.companion_connections from public, anon, authenticated;

create function companion_private.connection_companion(p_companion uuid)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  if not companion_private.chat_companion_ok(companion_private.chat_owner(), p_companion) then
    raise exception using errcode='P0001', message='companion not found';
  end if;
  return p_companion;
end $$;

-- What the Owner sees: never the key or token, only its last 4 characters.
create function companion_private.connection_json(p_companion uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_build_object('kind', c.kind, 'provider', c.provider, 'baseUrl', c.base_url, 'model', c.model,
      'name', c.name, 'keyHint', nullif(c.secret_hint, ''), 'connectedAt', c.updated_at)
    from companion_private.companion_connections c where c.companion_id = p_companion),
    jsonb_build_object('kind', 'PLATFORM', 'provider', null, 'baseUrl', null, 'model', null, 'name', null,
      'keyHint', null, 'connectedAt', null))
$$;

create function public.connection_get(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.connection_companion(p_companion);
begin
  return companion_private.connection_json(c);
end $$;

-- Server only: saves a connection the server has just tested. Replaces any earlier one.
create function public.connection_save(p_companion uuid, p_kind text, p_provider text, p_base_url text, p_model text,
  p_name text, p_secret text, p_hint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.connection_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  insert into companion_private.companion_connections as x
    (companion_id, kind, provider, base_url, model, name, secret, secret_hint, consented_at, updated_at)
  values (c, p_kind, p_provider, p_base_url, p_model, p_name, p_secret, p_hint, now(), now())
  on conflict (companion_id) do update set kind = excluded.kind, provider = excluded.provider, base_url = excluded.base_url,
    model = excluded.model, name = excluded.name, secret = excluded.secret, secret_hint = excluded.secret_hint,
    consented_at = excluded.consented_at, updated_at = excluded.updated_at;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'CONNECTION_SAVE_' || p_kind, 'COMPANION', c);
  return companion_private.connection_json(c);
end $$;

-- Back to the platform's models; the sealed key is deleted.
create function public.connection_delete(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.connection_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  delete from companion_private.companion_connections where companion_id = c;
  if found then
    insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
      values (o, c, 'OWNER', o, 'CONNECTION_DELETE', 'COMPANION', c);
  end if;
  return companion_private.connection_json(c);
end $$;

-- Server only: what a reply needs, with the sealed secret; null when the Companion uses the platform.
create function public.connection_secret(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.connection_companion(p_companion);
begin
  return (select jsonb_build_object('kind', x.kind, 'provider', x.provider, 'baseUrl', x.base_url, 'model', x.model,
      'name', x.name, 'secret', x.secret)
    from companion_private.companion_connections x where x.companion_id = c);
end $$;

revoke all on function companion_private.connection_companion(uuid), companion_private.connection_json(uuid)
  from public, anon, authenticated;
revoke all on function public.connection_get(uuid), public.connection_delete(uuid),
  public.connection_save(uuid, text, text, text, text, text, text, text), public.connection_secret(uuid)
  from public, anon, authenticated;
grant execute on function public.connection_get(uuid), public.connection_delete(uuid) to authenticated;
grant execute on function public.connection_save(uuid, text, text, text, text, text, text, text), public.connection_secret(uuid)
  to companion_api;

commit;
