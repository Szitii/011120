begin;

-- The Owner reads and rewrites a Companion's persona (家机说明: who it is and how it talks).
--
-- Until now a persona could only come from an imported card (name, description, personality), and
-- changing it meant importing again. Now the Owner can rewrite six fields at any time:
--   identitySummary 简介, personaTraits 性格, speakingStyle 说话风格, values 在意的事,
--   boundaries 边界, aspirations 向往.
-- The name is not changed here: it is also the Companion's name in the community.
--
-- A change is a new identity version (created_by OWNER) that takes the place of the current one,
-- like an approved import: earlier versions stay, and everything that reads the current version
-- (chat, diary, posts) uses the new text from the next call on. The public community profile is
-- a copy the Owner made on purpose (social persona) and does not change by itself.
--
-- Saving is server-only: the API server scans the texts first (keys, private data, injected
-- instructions, links), as it does for an import.

-- The current persona as stored. The server turns each field into the one text the models are told.
create function public.persona_get(p_companion uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return (select jsonb_build_object('companionId', x.id, 'displayName', i.display_name, 'version', i.version,
      'document', i.identity_document, 'updatedAt', i.created_at)
    from public.companions x join public.companion_identities i on i.id = x.current_identity_version_id
    where x.id = c);
end $$;

-- Server only. p_fields: {field: text} for any of the six; an empty text takes the field out.
-- p_version is the version the Owner was looking at: a stale one (another device saved first) is a
-- conflict. Nothing changed: no new version. At most 30 versions an hour per Companion.
create function public.persona_save(p_companion uuid, p_version integer, p_fields jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
  cur public.companion_identities%rowtype; doc jsonb; k text; v text;
  new_id uuid := gen_random_uuid(); manifest jsonb; hash text; at timestamptz := now();
begin
  if p_version is null or p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'
    or exists(select 1 from jsonb_each(p_fields) f
      where f.key not in ('identitySummary', 'personaTraits', 'speakingStyle', 'values', 'boundaries', 'aspirations')
        or jsonb_typeof(f.value) <> 'string' or char_length(f.value #>> '{}') > 600) then
    raise exception using errcode='22023', message='invalid persona';
  end if;
  perform 1 from public.companions where id = c for no key update;
  select i.* into cur from public.companions x join public.companion_identities i on i.id = x.current_identity_version_id
    where x.id = c;
  if cur.version <> p_version then raise exception using errcode='23505', message='persona version conflict'; end if;

  doc := cur.identity_document;
  for k, v in select f.key, btrim(f.value #>> '{}', E' \t\r\n') from jsonb_each(p_fields) f loop
    -- Stored in the shape an import gives the same field: a text, or a list of texts.
    doc := case when v = '' then doc - k
      when k in ('identitySummary', 'speakingStyle') then doc || jsonb_build_object(k, v)
      else doc || jsonb_build_object(k, jsonb_build_array(v)) end;
  end loop;
  if doc = cur.identity_document then return public.persona_get(c); end if;

  if (select count(*) from public.companion_identities where companion_id = c and created_at > at - interval '1 hour') >= 30 then
    raise exception using errcode='55000', message='too many persona changes';
  end if;
  manifest := jsonb_build_object('editedBy', 'OWNER', 'basedOnVersion', cur.version,
    'fields', (select jsonb_agg(f.key order by f.key) from jsonb_each(p_fields) f));
  hash := encode(sha256(convert_to((jsonb_build_object('companionId', c, 'version', cur.version + 1, 'displayName', cur.display_name,
    'identityDocument', doc, 'sourceManifest', manifest))::text, 'UTF8')), 'hex');
  insert into public.companion_identities(id, owner_id, companion_id, version, display_name, identity_document, source_manifest,
      content_hash, created_by, approved_by_owner_at, supersedes_identity_id)
    values (new_id, o, c, cur.version + 1, cur.display_name, doc, manifest, hash, 'OWNER', at, cur.id);
  update public.companions set current_identity_version_id = new_id, updated_at = at where id = c;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id, before_hash, after_hash)
    values (o, c, 'OWNER', o, 'COMPANION_PERSONA_EDITED', 'COMPANION_IDENTITY', new_id, cur.content_hash, hash);
  return public.persona_get(c);
end $$;

revoke all on function public.persona_get(uuid), public.persona_save(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.persona_get(uuid) to authenticated;
grant execute on function public.persona_save(uuid, integer, jsonb) to companion_api;

commit;
