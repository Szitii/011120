begin;

alter table public.community_actors
  add column human_display_name text check (char_length(human_display_name) between 1 and 80),
  add column human_bio text not null default '' check (char_length(human_bio) <= 500),
  add column human_profile_revision integer not null default 1 check (human_profile_revision >= 1),
  add constraint community_human_profile_only check (
    kind = 'HUMAN' or (human_display_name is null and human_bio = '' and human_profile_revision = 1)
  );

create or replace function companion_private.community_actor_json(p_actor uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'id', a.id,
    'kind', a.kind,
    'displayName', case when a.kind = 'HUMAN'
      then coalesce(a.human_display_name, o.display_name, '社区居民') else s.display_name end,
    'handle', case when a.kind = 'HUMAN' then 'human_' || replace(a.id::text, '-', '') else s.handle end,
    'bio', case when a.kind = 'HUMAN' then a.human_bio else coalesce(s.public_document->>'bio', '') end,
    'avatar', case when a.kind = 'HUMAN' then o.avatar_url else null end
  )
  from public.community_actors a
  join public.owners o on o.id = a.owner_id
  left join public.social_twins t on t.id = a.social_twin_id
  left join public.social_personas s on s.id = t.active_social_persona_id
  where a.id = p_actor
$$;

create function public.community_get_human_profile(p_kind text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.community_actors%rowtype;
begin
  actor := companion_private.community_actor(p_kind, p_actor);
  if actor.kind <> 'HUMAN' then
    raise exception using errcode='42501', message='human profile requires the human actor';
  end if;
  return jsonb_build_object(
    'displayName', coalesce(actor.human_display_name,
      (select display_name from public.owners where id = actor.owner_id), '社区居民'),
    'bio', actor.human_bio,
    'revision', actor.human_profile_revision
  );
end $$;

create function public.community_update_human_profile(
  p_kind text, p_actor uuid, p_name text, p_bio text, p_revision integer
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor public.community_actors%rowtype;
  clean_name text := btrim(p_name);
  clean_bio text := btrim(replace(p_bio, E'\r\n', E'\n'));
begin
  actor := companion_private.community_actor(p_kind, p_actor);
  if actor.kind <> 'HUMAN' then
    raise exception using errcode='42501', message='human profile requires the human actor';
  end if;
  if clean_name is null or char_length(clean_name) not between 1 and 80 or clean_name ~ '[[:cntrl:]]'
    or clean_bio is null or char_length(clean_bio) > 500 or translate(clean_bio, E'\n\t', '') ~ '[[:cntrl:]]'
    or p_revision is null or p_revision < 1 then
    raise exception using errcode='22023', message='invalid human profile';
  end if;

  select * into strict actor from public.community_actors where id = actor.id for update;
  -- Resending the same values after a dropped response has no additional effect.
  if actor.human_display_name is not distinct from clean_name and actor.human_bio = clean_bio then
    return jsonb_build_object('displayName', clean_name, 'bio', clean_bio, 'revision', actor.human_profile_revision);
  end if;
  if actor.human_profile_revision <> p_revision then
    raise exception using errcode='23505', message='human profile revision conflict';
  end if;

  update public.community_actors
  set human_display_name = clean_name, human_bio = clean_bio, human_profile_revision = human_profile_revision + 1
  where id = actor.id returning * into actor;

  insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
  values(actor.owner_id, 'HUMAN', actor.id, 'COMMUNITY_UPDATE_PROFILE', 'COMMUNITY_ACTOR', actor.id);
  return jsonb_build_object('displayName', clean_name, 'bio', clean_bio, 'revision', actor.human_profile_revision);
end $$;

revoke all on function companion_private.community_actor_json(uuid) from public, anon, authenticated;
revoke all on function public.community_get_human_profile(text, uuid) from public, anon;
revoke all on function public.community_update_human_profile(text, uuid, text, text, integer) from public, anon;
grant execute on function public.community_get_human_profile(text, uuid) to authenticated;
grant execute on function public.community_update_human_profile(text, uuid, text, text, integer) to authenticated;

commit;
