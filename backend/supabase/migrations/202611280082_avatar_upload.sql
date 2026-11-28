begin;

-- Uploaded avatars (自定义头像), for the Owner and for each Companion.
--
-- The file goes where post images go: the private bucket `media`, uploaded by the app with the
-- Owner's own sign-in, as "avatar/<uuid>.jpg|png|webp". The folder is flat, so a name says
-- nothing about whose it is; Storage records who uploaded it (storage.objects.owner_id). Then
-- the same two calls as for a built-in avatar:
--   PUT /v0/owner/avatar            { "avatar": "upload:<uuid>.jpg" }
--   PUT /v0/companions/{id}/avatar  { "avatar": "upload:<uuid>.jpg" }
-- The value is the file name with "upload:" in front, the way a built-in one is "preset:<id>";
-- the app turns it into the Storage address. The database checks that the file is there and that
-- this Owner uploaded it.
--
-- The three Storage rules of 0061 learn the new folder:
--   upload  an Owner in good standing; at most 30 avatar files kept, and 20 in an hour
--   read    one's own files, and a file that is now the avatar of an identity the caller may
--           see (so listing the folder never shows another Owner's private Companion)
--   delete  one's own files that are nobody's avatar now (the one just replaced)
-- The bucket's limits stay: 1 MB, jpeg/png/webp. Like post images, an avatar is not reviewed by
-- a machine; a reported account is suspended as a whole, and its avatar goes with it.

-- As in 0061: the functions below read storage.objects as their owner, whoever runs this migration.
do $$ begin
  if not has_table_privilege(current_user, 'storage.objects', 'SELECT')
    or not (select rolsuper or rolbypassrls from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'this migration must be run by a role that can read every row of storage.objects';
  end if;
end $$;

-- ---------- the value ----------

create or replace function companion_private.avatar_ok(p_avatar text)
returns boolean language sql immutable set search_path='' as $$
  select p_avatar is null or p_avatar ~
    '^(preset:[a-z0-9][a-z0-9_-]{0,39}|upload:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|webp))$'
$$;

alter table public.companions drop constraint companions_avatar_check;
alter table public.companions add constraint companions_avatar_check check (avatar ~
  '^(preset:[a-z0-9][a-z0-9_-]{0,39}|upload:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|webp))$');

-- The Storage rules look an avatar up by its value.
create index owners_avatar on public.owners(avatar_url) where avatar_url is not null;
create index companions_avatar on public.companions(avatar) where avatar is not null;

-- "avatar/<uuid>.<jpg|png|webp>"
create function public.media_is_avatar(p_name text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_name ~ '^avatar/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|webp)$', false)
$$;

-- A built-in avatar or none, or a file this Owner uploaded to the avatar folder.
create function companion_private.avatar_mine(p_avatar text)
returns boolean language sql stable security definer set search_path='' as $$
  select p_avatar is null or p_avatar like 'preset:%' or exists(select 1 from storage.objects f
    where f.bucket_id = 'media' and f.name = 'avatar/' || substr(p_avatar, 8)
      and f.owner_id::text = (select auth.uid())::text)
$$;

-- As in 0055, plus: an uploaded avatar must be the Owner's own file.
create or replace function public.owner_set_avatar(p_avatar text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  if not companion_private.avatar_ok(p_avatar) or not companion_private.avatar_mine(p_avatar) then
    raise exception using errcode='22023', message='invalid avatar';
  end if;
  update public.owners set avatar_url = p_avatar where id = o and avatar_url is distinct from p_avatar;
  if found then
    insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
      values (o, 'OWNER', o, 'OWNER_SET_AVATAR', 'OWNER', o);
  end if;
  return jsonb_build_object('avatar', p_avatar);
end $$;

create or replace function public.companion_set_avatar(p_companion uuid, p_avatar text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  if not companion_private.avatar_ok(p_avatar) or not companion_private.avatar_mine(p_avatar) then
    raise exception using errcode='22023', message='invalid avatar';
  end if;
  update public.companions set avatar = p_avatar, updated_at = now() where id = c and avatar is distinct from p_avatar;
  if found then
    insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
      values (o, c, 'OWNER', o, 'COMPANION_SET_AVATAR', 'COMPANION', c);
  end if;
  return jsonb_build_object('avatar', p_avatar);
end $$;

-- ---------- what a signed-in user may do with an avatar file (used by the Storage policies) ----------

-- As in 0061, or: an avatar file, from an Owner in good standing who keeps fewer than 30 and
-- uploaded fewer than 20 in the last hour. (As there, Storage checks before it takes the file, so
-- uploads started together can pass together: the counts are not a hard quota.)
create or replace function public.media_can_upload(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select (public.media_own(p_name)
    and split_part(p_name, '/', 1) in (select v.id::text from companion_private.media_actors() v(id))
    and not exists(select 1 from companion_private.post_media m where m.object_name = p_name)
    and (select count(*) from companion_private.media_actors() v(id) join storage.objects f
      on f.bucket_id = 'media' and f.name like v.id::text || '/%' where f.created_at > now() - interval '1 hour') < 60
    and (select count(*) from companion_private.media_actors() v(id) join storage.objects f
      on f.bucket_id = 'media' and f.name like v.id::text || '/%'
      where not exists(select 1 from companion_private.post_media m where m.object_name = f.name)) < 40)
  or (public.media_is_avatar(p_name)
    and exists(select 1 from public.owners o where o.auth_user_id = (select auth.uid()) and o.status = 'ACTIVE')
    and (select count(*) < 30 and count(*) filter (where f.created_at > now() - interval '1 hour') < 20
      from storage.objects f where f.bucket_id = 'media' and f.name like 'avatar/%'
        and f.owner_id::text = (select auth.uid())::text))
$$;

-- As in 0061, or: the file is now the avatar of an identity one of the caller's identities may see.
-- (The caller's own avatar files are let through by the policy itself, on the row's owner_id.)
create or replace function public.media_can_read(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.media_own(p_name) or exists(
    select 1 from companion_private.post_media m
    join public.community_posts p on p.id = m.post_id
    cross join companion_private.media_actors() v(id)
    where m.object_name = p_name and m.review_status = 'VISIBLE' and p.deleted_at is null
      and companion_private.community_visible(p.actor_id, v.id)
      and companion_private.community_post_open(p.actor_id, p.visibility, v.id))
  or (public.media_is_avatar(p_name) and (
    exists(select 1 from public.owners o join public.community_actors t on t.owner_id = o.id and t.kind = 'HUMAN'
      cross join companion_private.media_actors() v(id)
      where o.avatar_url = 'upload:' || substr(p_name, 8) and companion_private.community_visible(t.id, v.id))
    or exists(select 1 from public.companions c join public.social_twins st on st.companion_id = c.id
      join public.community_actors t on t.social_twin_id = st.id
      cross join companion_private.media_actors() v(id)
      where c.avatar = 'upload:' || substr(p_name, 8) and companion_private.community_visible(t.id, v.id))))
$$;

-- An avatar file that is nobody's avatar now (a deleted Companion does not hold on to its file).
create function public.media_avatar_unused(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.media_is_avatar(p_name)
    and not exists(select 1 from public.owners o where o.avatar_url = 'upload:' || substr(p_name, 8))
    and not exists(select 1 from public.companions c where c.avatar = 'upload:' || substr(p_name, 8) and c.status <> 'DELETED')
$$;

-- "One's own" is read from the row (owner_id), not looked up: a rule that looked the row up
-- would not find the very file being uploaded.
alter policy media_read on storage.objects
  using (bucket_id = 'media' and (public.media_can_read(name)
    or (owner_id::text = (select auth.uid())::text and public.media_is_avatar(name))));
alter policy media_delete on storage.objects
  using (bucket_id = 'media' and (public.media_can_delete(name)
    or (owner_id::text = (select auth.uid())::text and public.media_avatar_unused(name))));

revoke all on function companion_private.avatar_mine(text), public.media_is_avatar(text), public.media_avatar_unused(text)
  from public, anon, authenticated;
-- The Storage service asks as the signed-in user, so the policy functions are theirs to call.
grant execute on function public.media_is_avatar(text), public.media_avatar_unused(text) to authenticated;

insert into companion_private.schema_migrations(name) values ('202611280082_avatar_upload');

commit;
