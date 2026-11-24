begin;

-- Avatars picked from the app's built-in set (预设头像), for the Owner and for each Companion.
-- The value is "preset:<id>"; the app owns the pictures and maps the id to one, so nothing is
-- uploaded and nothing needs moderation. Uploaded avatars (an https URL in the same field) come
-- later with image storage. An avatar is public: everyone who can see the identity sees it.
--
--   PUT /v0/owner/avatar            { avatar }   the Owner's own
--   PUT /v0/companions/{id}/avatar  { avatar }   one of the Owner's Companions
-- It is returned as `avatar` wherever the identity is shown: community authors and profiles,
-- chat members, and the Owner's list of Companions.

create function companion_private.avatar_ok(p_avatar text)
returns boolean language sql immutable set search_path='' as $$
  select p_avatar is null or p_avatar ~ '^preset:[a-z0-9][a-z0-9_-]{0,39}$'
$$;

alter table public.companions add column avatar text check (avatar ~ '^preset:[a-z0-9][a-z0-9_-]{0,39}$');

-- The Owner's avatar (owners.avatar_url, shown for their human identity); null clears it.
create function public.owner_set_avatar(p_avatar text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  if not companion_private.avatar_ok(p_avatar) then raise exception using errcode='22023', message='invalid avatar'; end if;
  update public.owners set avatar_url = p_avatar where id = o and avatar_url is distinct from p_avatar;
  if found then
    insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
      values (o, 'OWNER', o, 'OWNER_SET_AVATAR', 'OWNER', o);
  end if;
  return jsonb_build_object('avatar', p_avatar);
end $$;

create function public.companion_set_avatar(p_companion uuid, p_avatar text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  if not companion_private.avatar_ok(p_avatar) then raise exception using errcode='22023', message='invalid avatar'; end if;
  update public.companions set avatar = p_avatar, updated_at = now() where id = c and avatar is distinct from p_avatar;
  if found then
    insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
      values (o, c, 'OWNER', o, 'COMPANION_SET_AVATAR', 'COMPANION', c);
  end if;
  return jsonb_build_object('avatar', p_avatar);
end $$;

-- Same as in 0031, with a Companion's avatar for an AI identity (it was always null).
create or replace function companion_private.community_actor_json(p_actor uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'id', a.id,
    'kind', a.kind,
    'displayName', case when a.kind = 'HUMAN'
      then coalesce(a.human_display_name, o.display_name, '社区居民') else s.display_name end,
    'handle', case when a.kind = 'HUMAN' then 'human_' || replace(a.id::text, '-', '') else s.handle end,
    'bio', case when a.kind = 'HUMAN' then a.human_bio else coalesce(s.public_document->>'bio', '') end,
    'avatar', case when a.kind = 'HUMAN' then o.avatar_url else c.avatar end
  )
  from public.community_actors a
  join public.owners o on o.id = a.owner_id
  left join public.social_twins t on t.id = a.social_twin_id
  left join public.companions c on c.id = t.companion_id
  left join public.social_personas s on s.id = t.active_social_persona_id
  where a.id = p_actor
$$;

-- Same as in 0040, plus the avatar.
create or replace function companion_private.chat_companion_json(p_companion uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('companionId', c.id, 'displayName', i.display_name, 'avatar', c.avatar)
  from public.companions c join public.companion_identities i on i.id = c.current_identity_version_id
  where c.id = p_companion
$$;

-- Same as in 0026, plus the avatar (left out when there is none, like the other optional fields).
create or replace function public.list_owner_companions()
returns table(item jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype;
begin
  select * into actor
  from public.owners
  where auth_user_id=(select auth.uid()) and status='ACTIVE';

  if not found then
    raise exception using errcode='42501',message='active Owner authentication is required';
  end if;

  return query
  select jsonb_strip_nulls(jsonb_build_object(
    'companionId',c.id,
    'displayName',ci.display_name,
    'identityId',ci.id,
    'identityVersion',ci.version,
    'approvedFields',(
      select coalesce(jsonb_agg(k order by k),'[]'::jsonb)
      from jsonb_object_keys(ci.identity_document) k
    ),
    'status',c.status,
    'socialReady',(st.id is not null and st.status<>'SUSPENDED' and sp.id is not null),
    'socialTwinId',st.id,
    'handle',sp.handle,
    'avatar',c.avatar
  ))
  from public.companions c
  join public.companion_identities ci
    on ci.id=c.current_identity_version_id
   and ci.companion_id=c.id
   and ci.owner_id=actor.id
  left join public.social_twins st
    on st.companion_id=c.id
   and st.owner_id=actor.id
  left join public.social_personas sp
    on sp.id=st.active_social_persona_id
   and sp.companion_id=c.id
  where c.owner_id=actor.id
    and c.status not in ('DELETED','QUARANTINED')
  order by c.created_at asc,c.id asc;
end $$;

revoke all on function companion_private.avatar_ok(text), public.owner_set_avatar(text), public.companion_set_avatar(uuid, text)
  from public, anon, authenticated;
grant execute on function public.owner_set_avatar(text), public.companion_set_avatar(uuid, text) to authenticated;

commit;
