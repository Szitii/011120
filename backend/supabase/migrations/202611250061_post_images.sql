begin;

-- Images on community posts (社区发图): 1 to 9 per post, no video.
--
-- The files live in Supabase Storage, in the private bucket `media`. No server holds a Storage
-- key: the app uploads and downloads with the Owner's own sign-in, and the three policies below
-- (on storage.objects, for signed-in users only) decide what that sign-in may do:
--   upload  into the folder of one of the Owner's own community identities,
--           "<identity id>/<uuid>.jpg|png|webp", a name that was never on a post; at most 60
--           files kept from the last hour and 40 files not yet on a post. The bucket itself
--           limits the size (5 MB) and the type. (Storage checks the policy before it takes the
--           file, so many uploads started at the same moment can pass together: the two counts
--           keep the bucket from being filled casually, they are not a hard quota.)
--   read    one's own files, and a file on a post that one of the Owner's identities may see
--           (the same rule as the post's text) while the image is VISIBLE.
--   delete  one's own files that are not on a live post (a cancelled draft, a deleted post).
--           A post the operators removed counts as live: they may put it back.
-- There is no update policy, so a file cannot be replaced after it was posted.
--
-- The folder is the identity that posts, not the account: a path is shown to everyone who sees
-- the post, and it must not tell them which identities belong to one Owner.
--
-- A post names its images when it is published (community_publish, p_media); the database checks
-- that each file is in the publishing identity's folder, was really uploaded and is on no post.
--
-- Review: every image has review_status. VISIBLE is the only value written now; REMOVED hides
-- one image from everyone but its owner. Machine review, when it comes, adds its own values
-- here; until then a reported post is taken down as a whole, and its images go with it.

-- The policy functions below read storage.objects as their owner, whoever runs this migration.
do $$ begin
  if not has_table_privilege(current_user, 'storage.objects', 'SELECT')
    or not (select rolsuper or rolbypassrls from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'this migration must be run by a role that can read every row of storage.objects';
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']::text[])
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table companion_private.post_media (
  object_name text primary key,
  post_id uuid not null references public.community_posts(id) on delete cascade,
  position smallint not null check (position between 1 and 9),
  -- Only images for now; a video would be another kind.
  kind text not null default 'IMAGE' check (kind in ('IMAGE')),
  width integer check (width between 1 and 99999),
  height integer check (height between 1 and 99999),
  alt text check (char_length(alt) between 1 and 200),
  review_status text not null default 'VISIBLE' check (review_status in ('VISIBLE', 'REMOVED')),
  created_at timestamptz not null default now(),
  unique (post_id, position)
);
alter table companion_private.post_media enable row level security;
alter table companion_private.post_media force row level security;
revoke all on companion_private.post_media from public, anon, authenticated;

-- ---------- what a signed-in user may do with a file (used by the Storage policies) ----------

-- The community identities the caller can act as now (their own, not suspended, of a living Companion).
create function companion_private.media_actors()
returns setof uuid language sql stable security definer set search_path='' as $$
  select v.id from public.owners o join public.community_actors v on v.owner_id = o.id
  where o.auth_user_id = (select auth.uid()) and o.status = 'ACTIVE'
    and (v.kind = 'HUMAN' or exists(select 1 from public.social_twins t join public.companions c on c.id = t.companion_id
      where t.id = v.social_twin_id and t.status <> 'SUSPENDED' and c.status not in ('DELETED', 'QUARANTINED')))
$$;

-- "<identity id>/<uuid>.<jpg|png|webp>" in the folder of any identity of the caller's, usable now or not.
create function public.media_own(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(p_name ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|webp)$'
    and exists(select 1 from public.community_actors v join public.owners o on o.id = v.owner_id
      where v.id::text = split_part(p_name, '/', 1) and o.auth_user_id = (select auth.uid())), false)
$$;

create function public.media_can_upload(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.media_own(p_name)
    and split_part(p_name, '/', 1) in (select v.id::text from companion_private.media_actors() v(id))
    and not exists(select 1 from companion_private.post_media m where m.object_name = p_name)
    and (select count(*) from companion_private.media_actors() v(id) join storage.objects f
      on f.bucket_id = 'media' and f.name like v.id::text || '/%' where f.created_at > now() - interval '1 hour') < 60
    and (select count(*) from companion_private.media_actors() v(id) join storage.objects f
      on f.bucket_id = 'media' and f.name like v.id::text || '/%'
      where not exists(select 1 from companion_private.post_media m where m.object_name = f.name)) < 40
$$;

create function public.media_can_read(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.media_own(p_name) or exists(
    select 1 from companion_private.post_media m
    join public.community_posts p on p.id = m.post_id
    cross join companion_private.media_actors() v(id)
    where m.object_name = p_name and m.review_status = 'VISIBLE' and p.deleted_at is null
      and companion_private.community_visible(p.actor_id, v.id)
      and companion_private.community_post_open(p.actor_id, p.visibility, v.id))
$$;

create function public.media_can_delete(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.media_own(p_name) and not exists(
    select 1 from companion_private.post_media m join public.community_posts p on p.id = m.post_id
    where m.object_name = p_name and (p.deleted_at is null or p.body = companion_private.admin_removed_text()))
$$;

create policy media_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.media_can_upload(name));
create policy media_read on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.media_can_read(name));
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.media_can_delete(name));

-- ---------- posts carry their images ----------

-- Same as in 0056, plus media: the images that are VISIBLE, in order.
create or replace function companion_private.community_post_json(p_post uuid,p_viewer uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',p.id,'author',companion_private.community_actor_json(p.actor_id),
    'body',p.body,'createdAt',p.created_at,'source',p.source,'visibility',p.visibility,
    'mentions',companion_private.community_mentions_json(p.mentions,p_viewer),
    'media',coalesce((select jsonb_agg(jsonb_build_object('kind',m.kind,'path',m.object_name,'width',m.width,
        'height',m.height,'alt',m.alt) order by m.position)
      from companion_private.post_media m where m.post_id=p.id and m.review_status='VISIBLE'),'[]'),
    'commentsCount',(select count(*) from public.community_comments c where c.post_id=p.id and c.deleted_at is null
      and companion_private.community_visible(c.actor_id,p_viewer)),
    'likeCount',(select count(*) from public.community_likes l where l.post_id=p.id),
    'likedByMe',exists(select 1 from public.community_likes l where l.post_id=p.id and l.actor_id=p_viewer),
    'canDelete',p.actor_id=p_viewer)
  from public.community_posts p where p.id=p_post
$$;

drop function public.community_publish(text, uuid, uuid, text, text, uuid[], text, text);
-- Same as in 0056, plus p_media for a new post: null or [{"path", "width"?, "height"?, "alt"?}],
-- at most 9, in the order they are shown. Each path must be a file uploaded to the publishing
-- identity's folder that is on no post yet; otherwise nothing is published. A retry with the
-- same key and other images is a conflict. (p_media comes last with a default, so the API
-- server deployed before this migration keeps working.)
create function public.community_publish(p_kind text, p_id uuid, p_post uuid, p_body text, p_visibility text,
  p_mentions uuid[], p_key text, p_hash text, p_media jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; v_visibility text := coalesce(p_visibility, 'PUBLIC'); v_mentions uuid[];
  replay boolean; result jsonb; v_id uuid; author uuid; notify boolean := companion_private.feature_on('COMMUNITY_NEW_NOTICES');
  v_media jsonb := coalesce(p_media, '[]'); v_paths text[];
begin
  a := companion_private.community_actor(p_kind, p_id);
  if v_visibility not in ('PUBLIC', 'FOLLOWERS', 'PRIVATE') or (p_post is not null and p_visibility is not null)
    or (select count(distinct m) from unnest(coalesce(p_mentions, '{}')) m) > 10
    or jsonb_typeof(v_media) <> 'array' or jsonb_array_length(v_media) > 9
    or (p_post is not null and jsonb_array_length(v_media) > 0) then
    raise exception using errcode='22023', message='invalid publication';
  end if;
  if exists(select 1 from jsonb_array_elements(v_media) e where jsonb_typeof(e) <> 'object'
      or jsonb_typeof(e->'path') is distinct from 'string'
      or coalesce(e->>'width', '1') !~ '^[1-9][0-9]{0,4}$' or coalesce(e->>'height', '1') !~ '^[1-9][0-9]{0,4}$'
      or coalesce(jsonb_typeof(e->'alt'), 'string') not in ('string', 'null') or char_length(e->>'alt') > 200) then
    raise exception using errcode='22023', message='invalid media';
  end if;
  v_paths := array(select e->>'path' from jsonb_array_elements(v_media) with ordinality t(e, n) order by n);
  select actor_id into author from public.community_posts where id = p_post;
  if author is not null then perform companion_private.community_lock_pair(a.id, author); end if;
  perform 1 from public.community_actors where id = a.id for update;
  replay := exists(select 1 from companion_private.community_requests where actor_id = a.id and key_hash = p_key);
  result := public.community_command(p_kind, p_id, case when p_post is null then 'POST' else 'COMMENT' end, p_post, p_body, p_key, p_hash);
  v_id := (result->>'id')::uuid;
  if replay then
    if p_post is null and ((select visibility from public.community_posts where id = v_id) <> v_visibility
        or v_paths <> array(select m.object_name from companion_private.post_media m where m.post_id = v_id order by m.position)) then
      raise exception using errcode='23505', message='idempotency conflict';
    end if;
    return result;
  end if;
  v_mentions := array(select m from unnest(coalesce(p_mentions, '{}')) with ordinality t(m, n)
    where m is not null and m <> a.id and companion_private.community_visible(m, a.id) group by m order by min(n));
  if p_post is null then
    -- Uploaded files in this identity's folder, each once, on no post yet. Raising here undoes the post.
    if (select count(distinct x) from unnest(v_paths) x) <> cardinality(v_paths)
      or exists(select 1 from unnest(v_paths) x where split_part(x, '/', 1) <> a.id::text
        or not exists(select 1 from storage.objects f where f.bucket_id = 'media' and f.name = x)
        or exists(select 1 from companion_private.post_media m where m.object_name = x)) then
      raise exception using errcode='22023', message='invalid media';
    end if;
    insert into companion_private.post_media(object_name, post_id, position, width, height, alt)
      select e->>'path', v_id, n, (e->>'width')::integer, (e->>'height')::integer, nullif(btrim(e->>'alt'), '')
      from jsonb_array_elements(v_media) with ordinality t(e, n);
    update public.community_posts set visibility = v_visibility, mentions = v_mentions where id = v_id;
    if notify then
      insert into public.community_notifications(recipient_id, actor_id, kind, post_id)
        select m, a.id, 'MENTION', v_id from unnest(v_mentions) m where companion_private.community_post_visible(v_id, m)
        on conflict do nothing;
    end if;
    return companion_private.community_post_json(v_id, a.id);
  end if;
  update public.community_comments set mentions = v_mentions where id = v_id;
  if notify then
    insert into public.community_notifications(recipient_id, actor_id, kind, post_id, comment_id)
      select m, a.id, 'MENTION', p_post, v_id from unnest(v_mentions) m
      where m <> author and companion_private.community_post_visible(p_post, m)
      on conflict do nothing;
  end if;
  return companion_private.community_comment_json(v_id, a.id);
end $$;

revoke all on function companion_private.media_actors(), public.media_own(text), public.media_can_upload(text), public.media_can_read(text),
  public.media_can_delete(text), public.community_publish(text, uuid, uuid, text, text, uuid[], text, text, jsonb)
  from public, anon, authenticated;
-- The Storage service asks as the signed-in user, so the policy functions are theirs to call.
grant execute on function public.media_own(text), public.media_can_upload(text), public.media_can_read(text),
  public.media_can_delete(text), public.community_publish(text, uuid, uuid, text, text, uuid[], text, text, jsonb)
  to authenticated;

commit;
