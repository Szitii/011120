begin;

-- 1. Feature switches the operators flip (admin console), and the app reads (GET /v0/features).
--    First ones: group chats are paused for the first release.
--      GROUP_CHAT_CREATE  off: no new group chat (POST /v0/chats with more than one Companion).
--      GROUP_CHAT_SEND    off: existing group chats can be read and deleted, but the Owner cannot
--                         send or retry in them. One-to-one chats are not affected.
--    Enforced by triggers on the chat tables, so every path (old app versions, direct routes,
--    future functions) is covered, not only the endpoints that exist today.
-- 2. Import review: a candidate the Import Firewall blocked (a key, private data, an injection)
--    keeps its id, field, path and finding ids, but its text is no longer stored or sent back
--    (value null). The original upload is not kept either: its hash and size are enough for the
--    audit trail, and a copy that is never read is only something to leak. (The review payload
--    strips nulls, so the app sees a blocked candidate without `value`.)

-- ---------- feature switches ----------

create table companion_private.feature_switches (
  key text primary key check (key in ('GROUP_CHAT_CREATE', 'GROUP_CHAT_SEND')),
  enabled boolean not null,
  updated_at timestamptz not null default now()
);
insert into companion_private.feature_switches(key, enabled) values ('GROUP_CHAT_CREATE', false), ('GROUP_CHAT_SEND', false);
alter table companion_private.feature_switches enable row level security;
alter table companion_private.feature_switches force row level security;
revoke all on companion_private.feature_switches from public, anon, authenticated;

create function companion_private.feature_on(p_key text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select enabled from companion_private.feature_switches where key = p_key), false)
$$;

-- What the app may offer. The server adds what depends on its own configuration.
create function public.platform_features()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('groupChatCreate', companion_private.feature_on('GROUP_CHAT_CREATE'),
    'groupChatSend', companion_private.feature_on('GROUP_CHAT_SEND'))
$$;

create function companion_private.group_chat_create_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.direct_companion_id is null and not companion_private.feature_on('GROUP_CHAT_CREATE') then
    raise exception using errcode='55000', message='group chats are paused';
  end if;
  return new;
end $$;
create trigger chats_group_create_guard before insert on companion_private.chats
  for each row execute function companion_private.group_chat_create_guard();

-- The Owner speaking (a message) or asking again (a retry) in a group chat. Companion turns that
-- were already queued finish as usual.
create function companion_private.group_chat_send_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (tg_op = 'INSERT' and new.companion_id is null or tg_op = 'UPDATE' and new.status = 'PENDING' and old.status <> 'PENDING')
    and not companion_private.feature_on('GROUP_CHAT_SEND')
    and exists(select 1 from companion_private.chats c where c.id = new.chat_id and c.direct_companion_id is null) then
    raise exception using errcode='55000', message='group chats are paused';
  end if;
  return new;
end $$;
create trigger chat_messages_group_send_guard before insert or update of status on companion_private.chat_messages
  for each row execute function companion_private.group_chat_send_guard();

-- Operators: turn a feature on or off, with a reason, logged like every console action.
create function companion_admin.feature_set(p_key text, p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_before boolean;
begin
  select enabled into v_before from companion_private.feature_switches where key = p_key for update;
  if not found then raise exception using errcode='22023', message='unknown feature'; end if;
  update companion_private.feature_switches set enabled = p_enabled, updated_at = now() where key = p_key;
  perform companion_private.admin_note('FEATURE_SWITCH', 'FEATURE', p_key, null, p_reason,
    jsonb_build_object('enabled', p_enabled, 'before', v_before));
end $$;

create function companion_admin.features()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'enabled', enabled, 'updatedAt', updated_at) order by key), '[]')
  from companion_private.feature_switches
$$;

revoke all on function companion_private.feature_on(text), companion_private.group_chat_create_guard(),
  companion_private.group_chat_send_guard(), public.platform_features(),
  companion_admin.feature_set(text, boolean, text), companion_admin.features() from public, anon, authenticated;
grant execute on function public.platform_features() to authenticated;
grant execute on function companion_admin.feature_set(text, boolean, text), companion_admin.features() to companion_admin;

-- ---------- import review: no blocked text, no original ----------

-- The draft with the text of every candidate that cannot be approved removed (value null).
create function companion_private.import_redact(p_draft jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_draft->'candidates') = 'array' then jsonb_set(p_draft, '{candidates}',
    coalesce((select jsonb_agg(case when (c->>'approvable')::boolean is true then c else c || '{"value": null}' end order by n)
      from jsonb_array_elements(p_draft->'candidates') with ordinality x(c, n)), '[]'))
  else p_draft end
$$;
revoke all on function companion_private.import_redact(jsonb) from public, anon, authenticated;

alter table companion_private.companion_imports alter column raw_payload drop not null;
update companion_private.companion_imports
  set raw_payload = null, normalized_draft = companion_private.import_redact(normalized_draft);

-- Same as in 0022, except the draft is stored redacted and the original is not stored.
create or replace function public.create_companion_import(
  p_raw_payload text,
  p_original_sha256 text,
  p_byte_length integer,
  p_parser_version text,
  p_policy_version text,
  p_source_format text,
  p_draft jsonb,
  p_findings jsonb,
  p_idempotency_key_hash text,
  p_request_hash text
) returns table(payload jsonb)
language plpgsql security definer set search_path='' as $$
declare actor public.owners%rowtype; existing companion_private.companion_imports%rowtype; created companion_private.companion_imports%rowtype; f jsonb; new_id uuid:=gen_random_uuid();
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_raw_payload is null or p_byte_length<1 or p_byte_length>262144
    or p_original_sha256!~'^[a-f0-9]{64}$' or p_idempotency_key_hash!~'^[a-f0-9]{64}$'
    or p_request_hash!~'^[a-f0-9]{64}$' or p_source_format not in ('CHARACTER_CARD_JSON_V2','LEGACY_CHARACTER_JSON')
    or p_draft is null or jsonb_typeof(p_draft)<>'object' or p_findings is null or jsonb_typeof(p_findings)<>'array' then
    raise exception using errcode='22023',message='invalid sanitized Companion import';
  end if;
  if octet_length(convert_to(p_raw_payload,'UTF8'))<>p_byte_length
    or encode(sha256(convert_to(p_raw_payload,'UTF8')),'hex')<>p_original_sha256 then
    raise exception using errcode='22023',message='Companion import payload attribution mismatch';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.companion_imports
    where owner_id=actor.id and import_idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.request_hash<>p_request_hash or existing.original_sha256<>p_original_sha256 then
      raise exception using errcode='23505',message='Companion import idempotency key reused with a different request';
    end if;
    return query select companion_private.import_review_payload(existing); return;
  end if;

  insert into companion_private.companion_imports(
    id,owner_id,status,status_history,original_sha256,byte_length,parser_version,policy_version,
    source_format,raw_payload,normalized_draft,import_idempotency_key_hash,request_hash
  ) values(
    new_id,actor.id,'REVIEWABLE','["UPLOADED","QUARANTINED","REVIEWABLE"]'::jsonb,
    p_original_sha256,p_byte_length,p_parser_version,p_policy_version,p_source_format,
    null,companion_private.import_redact(p_draft),p_idempotency_key_hash,p_request_hash
  ) returning * into created;

  for f in select * from jsonb_array_elements(p_findings) loop
    if coalesce(f->>'id','')='' or coalesce(f->>'type','')='' or coalesce(f->>'severity','')=''
      or coalesce(f->>'sourcePath','')='' or coalesce(f->>'action','')='' or coalesce(f->>'evidenceHash','')!~'^[a-f0-9]{64}$' then
      raise exception using errcode='22023',message='invalid sanitized import finding';
    end if;
    insert into companion_private.import_findings(
      import_id,finding_key,finding_type,severity,source_path,action,evidence_hash,safe_preview
    ) values(
      new_id,f->>'id',f->>'type',f->>'severity',f->>'sourcePath',f->>'action',f->>'evidenceHash',f->>'safePreview'
    );
  end loop;

  insert into public.audit_events(id,owner_id,actor_type,actor_id,action,target_type,target_id,after_hash,occurred_at)
  values(gen_random_uuid(),actor.id,'OWNER',actor.id,'COMPANION_IMPORT_CREATED','COMPANION_IMPORT',new_id,p_original_sha256,statement_timestamp());

  return query select companion_private.import_review_payload(created);
end $$;

commit;
