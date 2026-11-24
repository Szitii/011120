begin;

-- Three additions to the community:
--   1. Who can see a post (动态可见范围): PUBLIC (default), FOLLOWERS (the author's followers)
--      or PRIVATE (only the identity that posted it).
--   2. @mentions: a post or comment names up to 10 identities; each one that can see it is told.
--   3. A like tells the post's author.
--
-- Posting still goes through community_command (every existing check, retry keys, agent
-- settings). The new public.community_publish wraps it: in the same transaction it sets the
-- visibility and the mentions on what was just written and adds the notifications.

alter table public.community_posts
  add column visibility text not null default 'PUBLIC' check (visibility in ('PUBLIC', 'FOLLOWERS', 'PRIVATE')),
  add column mentions uuid[] not null default '{}' check (cardinality(mentions) <= 10);
alter table public.community_comments
  add column mentions uuid[] not null default '{}' check (cardinality(mentions) <= 10);

alter table public.community_notifications drop constraint community_notifications_kind_check;
alter table public.community_notifications add constraint community_notifications_kind_check
  check (kind in ('COMMENT', 'FOLLOW', 'LIKE', 'MENTION'));
-- One notice per liker and post, and per mentioned identity and post or comment.
create unique index community_like_notice on public.community_notifications(recipient_id, actor_id, post_id) where kind = 'LIKE';
create unique index community_post_mention_notice on public.community_notifications(recipient_id, post_id)
  where kind = 'MENTION' and comment_id is null;
create unique index community_comment_mention_notice on public.community_notifications(recipient_id, comment_id)
  where kind = 'MENTION' and comment_id is not null;

-- The one rule for "this viewer can see this post": it is not withdrawn, the viewer can see its
-- author (blocks, suspended and deleted identities), and its visibility lets the viewer in.
create function companion_private.community_post_visible(p_post uuid, p_viewer uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.community_posts p
    where p.id = p_post and p.deleted_at is null and companion_private.community_visible(p.actor_id, p_viewer)
      and (p.visibility = 'PUBLIC' or p.actor_id = p_viewer
        or (p.visibility = 'FOLLOWERS' and exists(select 1 from public.community_follows f
          where f.actor_id = p_viewer and f.target_id = p.actor_id))))
$$;

-- The mentioned identities the viewer can see, in the order they were named.
create function companion_private.community_mentions_json(p_mentions uuid[], p_viewer uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(companion_private.community_actor_json(m) order by n), '[]')
  from unnest(p_mentions) with ordinality t(m, n) where companion_private.community_visible(m, p_viewer)
$$;

-- Same as in 0054, with the real visibility and the mentions.
create or replace function companion_private.community_post_json(p_post uuid,p_viewer uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',p.id,'author',companion_private.community_actor_json(p.actor_id),
    'body',p.body,'createdAt',p.created_at,'source',p.source,'visibility',p.visibility,
    'mentions',companion_private.community_mentions_json(p.mentions,p_viewer),
    'commentsCount',(select count(*) from public.community_comments c where c.post_id=p.id and c.deleted_at is null
      and companion_private.community_visible(c.actor_id,p_viewer)),
    'likeCount',companion_private.community_like_count(p.id,p_viewer),
    'likedByMe',exists(select 1 from public.community_likes l where l.post_id=p.id and l.actor_id=p_viewer),
    'canDelete',p.actor_id=p_viewer)
  from public.community_posts p where p.id=p_post
$$;

-- Same as in 0030, with the mentions.
create or replace function companion_private.community_comment_json(p_comment uuid,p_viewer uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'postId',c.post_id,'author',companion_private.community_actor_json(c.actor_id),
    'body',c.body,'createdAt',c.created_at,'source',c.source,
    'mentions',companion_private.community_mentions_json(c.mentions,p_viewer),'canDelete',c.actor_id=p_viewer)
  from public.community_comments c where c.id=p_comment
$$;

-- Whether a notification is shown to its recipient (the list and the badges use this one rule).
-- Same as in 0046 for FOLLOW and COMMENT, with the post's visibility; LIKE while the like stands;
-- MENTION while the post (and the comment, if it was in one) is still there and visible.
create or replace function companion_private.community_notice_shown(nt public.community_notifications)
returns boolean language sql stable security definer set search_path='' as $$
  select companion_private.community_visible(nt.actor_id, nt.recipient_id)
    and (nt.kind = 'FOLLOW' and exists(select 1 from public.community_follows f where f.actor_id = nt.actor_id and f.target_id = nt.recipient_id)
      or nt.kind = 'COMMENT' and companion_private.community_post_visible(nt.post_id, nt.recipient_id)
        and exists(select 1 from public.community_comments c where c.id = nt.comment_id and c.deleted_at is null)
      or nt.kind = 'LIKE' and companion_private.community_post_visible(nt.post_id, nt.recipient_id)
        and exists(select 1 from public.community_likes l where l.post_id = nt.post_id and l.actor_id = nt.actor_id)
      or nt.kind = 'MENTION' and companion_private.community_post_visible(nt.post_id, nt.recipient_id)
        and (nt.comment_id is null or exists(select 1 from public.community_comments c where c.id = nt.comment_id and c.deleted_at is null)))
$$;

-- A comment needs a post its author can see. community_write checks the post's author; this
-- adds the post's visibility for every path that writes a comment (direct, or a published draft).
create function companion_private.community_comment_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not companion_private.community_post_visible(new.post_id, new.actor_id) then
    raise exception using errcode='P0001', message='post not found';
  end if;
  return new;
end $$;
create trigger community_comments_visible_guard before insert on public.community_comments
  for each row execute function companion_private.community_comment_guard();

-- Same as in 0032, with: posts filtered by visibility (feed, profile count, detail), notifications
-- shown by community_notice_shown (so the list and the badges cannot disagree), and commentId on
-- a notification.
create or replace function public.community_read(p_kind text,p_id uuid,p_resource text,p_target uuid default null,
  p_mode text default 'LATEST',p_filter text default 'ALL',p_before_at timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; target uuid; items jsonb; page jsonb; last_item jsonb; n integer; can_publish boolean;
begin
  a:=companion_private.community_actor(p_kind,p_id);
  if p_resource not in ('profile','feed','detail','notifications','blocks') or p_resource is null
    or p_mode not in ('LATEST','FOLLOWING') or p_mode is null or p_filter not in ('ALL','HUMAN','AI') or p_filter is null
    or ((p_before_at is null)<>(p_before_id is null)) then
    raise exception using errcode='22023',message='invalid community page';
  end if;
  if p_resource='profile' then
    target:=coalesce(p_target,a.id);
    if not companion_private.community_visible(target,a.id) then raise exception using errcode='P0001',message='profile not found'; end if;
    can_publish:=target=a.id and (a.kind='HUMAN' or exists(select 1 from public.social_twins t
      join public.social_personas s on s.id=t.active_social_persona_id join public.companions c on c.id=t.companion_id
      where t.id=a.social_twin_id and t.status='ACTIVE' and c.status='ACTIVE' and s.profile_visibility='PUBLIC'));
    return companion_private.community_actor_json(target)||jsonb_build_object('isSelf',target=a.id,
      'canPublish',can_publish,
      'following',exists(select 1 from public.community_follows where actor_id=a.id and target_id=target),
      'followersCount',(select count(*) from public.community_follows f where f.target_id=target and companion_private.community_visible(f.actor_id,a.id)),
      'followingCount',(select count(*) from public.community_follows f where f.actor_id=target and companion_private.community_visible(f.target_id,a.id)),
      'postsCount',(select count(*) from public.community_posts p where p.actor_id=target and companion_private.community_post_visible(p.id,a.id)));
  elsif p_resource='feed' then
    if p_target is not null and not companion_private.community_visible(p_target,a.id) then raise exception using errcode='P0001',message='profile not found'; end if;
    select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id desc),'[]') into items from (
      select p.created_at,p.id,companion_private.community_post_json(p.id,a.id) item from public.community_posts p
        join public.community_actors ca on ca.id=p.actor_id
      where p.deleted_at is null and companion_private.community_post_visible(p.id,a.id)
        and (p_target is null or p.actor_id=p_target) and (p_filter='ALL' or ca.kind=p_filter)
        and (p_mode='LATEST' or exists(select 1 from public.community_follows f where f.actor_id=a.id and f.target_id=p.actor_id))
        and (p_before_at is null or (p.created_at,p.id)<(p_before_at,p_before_id))
      order by p.created_at desc,p.id desc limit 21) q;
  elsif p_resource='detail' then
    if not companion_private.community_post_visible(p_target,a.id) then raise exception using errcode='P0001',message='post not found'; end if;
    select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id desc),'[]') into items from (
      select c.created_at,c.id,companion_private.community_comment_json(c.id,a.id) item from public.community_comments c
      where c.post_id=p_target and c.deleted_at is null and companion_private.community_visible(c.actor_id,a.id)
        and (p_before_at is null or (c.created_at,c.id)<(p_before_at,p_before_id))
      order by c.created_at desc,c.id desc limit 21) q;
  elsif p_resource='blocks' then
    select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id desc),'[]') into items from (
      select b.created_at,b.target_id id,jsonb_build_object('id',b.target_id,
        'actor',case when companion_private.community_profile_available(b.target_id,a.id)
          then companion_private.community_actor_json(b.target_id)
          else jsonb_build_object('id',b.target_id,'kind',ca.kind,'displayName','已屏蔽身份','handle','','bio','','avatar',null)
          end,'createdAt',b.created_at) item
      from public.community_blocks b join public.community_actors ca on ca.id=b.target_id where b.actor_id=a.id
        and (p_before_at is null or (b.created_at,b.target_id)<(p_before_at,p_before_id))
      order by b.created_at desc,b.target_id desc limit 21) q;
  else
    select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id desc),'[]') into items from (
      select nt.created_at,nt.id,jsonb_build_object('id',nt.id,'kind',nt.kind,
        'actor',companion_private.community_actor_json(nt.actor_id),'postId',nt.post_id,'commentId',nt.comment_id,
        'createdAt',nt.created_at,'readAt',nt.read_at) item from public.community_notifications nt
      where nt.recipient_id=a.id and companion_private.community_notice_shown(nt)
        and (p_before_at is null or (nt.created_at,nt.id)<(p_before_at,p_before_id))
      order by nt.created_at desc,nt.id desc limit 21) q;
  end if;
  n:=jsonb_array_length(items);
  if n>20 then items:=items-20; end if;
  last_item:=items->(jsonb_array_length(items)-1);
  page:=jsonb_build_object('items',items,'nextCursor',case when n>20 then (last_item->>'createdAt')||'|'||(last_item->>'id') else null end);
  if p_resource='detail' then return jsonb_build_object('post',companion_private.community_post_json(p_target,a.id),'comments',page); end if;
  return page;
end $$;

-- Same as in 0054, with the post's visibility, and a notice to the author for a new like
-- (kept when the like is taken back, so liking again does not tell them twice; it is only shown
-- while the like stands).
create or replace function public.community_like(p_kind text, p_id uuid, p_post uuid, p_liked boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; s companion_private.agent_settings%rowtype; reason text; author uuid;
begin
  a := companion_private.community_actor(p_kind, p_id);
  if p_liked is null then raise exception using errcode='22023', message='invalid like'; end if;
  if not companion_private.community_post_visible(p_post, a.id) then
    raise exception using errcode='P0001', message='post not found';
  end if;
  if a.kind = 'AI' then
    if not exists(select 1 from public.social_twins t join public.social_personas sp on sp.id = t.active_social_persona_id
        join public.companions c on c.id = t.companion_id
        where t.id = a.social_twin_id and t.status = 'ACTIVE' and c.status = 'ACTIVE' and sp.profile_visibility = 'PUBLIC') then
      raise exception using errcode='42501', message='public social identity is not active';
    end if;
    s := companion_private.agent_settings_for(p_kind, p_id);
    reason := companion_private.agent_refusal(s, companion_private.agent_settings_json(s), 'LIKE', p_post);
    if reason is not null then
      raise exception using errcode='42501', message='agent settings refuse this write: ' || reason;
    end if;
  end if;
  if p_liked then
    -- One at a time per identity, so the hourly count cannot be raced.
    perform 1 from public.community_actors where id = a.id for update;
    if not exists(select 1 from public.community_likes where post_id = p_post and actor_id = a.id) then
      if (select count(*) from public.community_likes where actor_id = a.id and created_at > now() - interval '1 hour') >= 300 then
        raise exception using errcode='55000', message='community like limit reached';
      end if;
      insert into public.community_likes(post_id, actor_id) values (p_post, a.id) on conflict do nothing;
      select actor_id into author from public.community_posts where id = p_post;
      if author <> a.id then
        insert into public.community_notifications(recipient_id, actor_id, kind, post_id) values (author, a.id, 'LIKE', p_post)
          on conflict do nothing;
      end if;
    end if;
  else
    delete from public.community_likes where post_id = p_post and actor_id = a.id;
  end if;
  return jsonb_build_object('liked', p_liked, 'likeCount', companion_private.community_like_count(p_post, a.id));
end $$;

-- A new post (p_post null) or a comment on p_post, with who can see it (posts only; null means
-- PUBLIC) and who is mentioned. Mentions the author cannot see, the author itself and repeats are
-- dropped; more than 10 is refused. A mentioned identity is told if it can see the post; in a
-- comment the post's author is not told twice (the comment already tells them).
-- A retry with the same key returns what was written; a retry that asks for another visibility
-- is a conflict.
create function public.community_publish(p_kind text, p_id uuid, p_post uuid, p_body text, p_visibility text,
  p_mentions uuid[], p_key text, p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; v_visibility text := coalesce(p_visibility, 'PUBLIC'); v_mentions uuid[];
  replay boolean; result jsonb; v_id uuid;
begin
  a := companion_private.community_actor(p_kind, p_id);
  if v_visibility not in ('PUBLIC', 'FOLLOWERS', 'PRIVATE') or (p_post is not null and p_visibility is not null)
    or (select count(distinct m) from unnest(coalesce(p_mentions, '{}')) m) > 10 then
    raise exception using errcode='22023', message='invalid publication';
  end if;
  v_mentions := array(select m from unnest(coalesce(p_mentions, '{}')) with ordinality t(m, n)
    where m is not null and m <> a.id and companion_private.community_visible(m, a.id) group by m order by min(n));
  replay := exists(select 1 from companion_private.community_requests where actor_id = a.id and key_hash = p_key);
  result := public.community_command(p_kind, p_id, case when p_post is null then 'POST' else 'COMMENT' end, p_post, p_body, p_key, p_hash);
  v_id := (result->>'id')::uuid;
  if replay then
    if p_post is null and (select visibility from public.community_posts where id = v_id) <> v_visibility then
      raise exception using errcode='23505', message='idempotency conflict';
    end if;
    return result;
  end if;
  if p_post is null then
    update public.community_posts set visibility = v_visibility, mentions = v_mentions where id = v_id;
    insert into public.community_notifications(recipient_id, actor_id, kind, post_id)
      select m, a.id, 'MENTION', v_id from unnest(v_mentions) m where companion_private.community_post_visible(v_id, m)
      on conflict do nothing;
    return companion_private.community_post_json(v_id, a.id);
  end if;
  update public.community_comments set mentions = v_mentions where id = v_id;
  insert into public.community_notifications(recipient_id, actor_id, kind, post_id, comment_id)
    select m, a.id, 'MENTION', p_post, v_id from unnest(v_mentions) m
    where companion_private.community_post_visible(p_post, m)
      and m <> (select actor_id from public.community_posts where id = p_post)
    on conflict do nothing;
  return companion_private.community_comment_json(v_id, a.id);
end $$;

revoke all on function companion_private.community_post_visible(uuid, uuid), companion_private.community_mentions_json(uuid[], uuid),
  companion_private.community_comment_guard(), public.community_publish(text, uuid, uuid, text, text, uuid[], text, text)
  from public, anon, authenticated;
grant execute on function public.community_publish(text, uuid, uuid, text, text, uuid[], text, text) to authenticated;

commit;
