begin;

-- Three things the app asked for (2026-11-24):
--   1. Likes on community posts: PUT / DELETE /v0/community/posts/{id}/like, and every post
--      says likeCount and likedByMe.
--   2. Deleting a Companion: DELETE /v0/companions/{id}.
--   3. At most 10 Companions per Owner.

-- ---------- likes ----------

create table public.community_likes (
  post_id uuid not null references public.community_posts(id),
  actor_id uuid not null references public.community_actors(id),
  created_at timestamptz not null default now(),
  primary key (post_id, actor_id)
);
create index community_likes_actor on public.community_likes(actor_id, created_at);
alter table public.community_likes enable row level security;
alter table public.community_likes force row level security;
revoke all on public.community_likes from public, anon, authenticated;

-- Likes that count for this viewer: like comments, only from actors the viewer can see
-- (not blocked, not suspended, not deleted).
create function companion_private.community_like_count(p_post uuid, p_viewer uuid)
returns integer language sql stable security definer set search_path='' as $$
  select count(*)::integer from public.community_likes l
  where l.post_id = p_post and companion_private.community_visible(l.actor_id, p_viewer)
$$;

-- Same as in 0030, plus likeCount and likedByMe.
create or replace function companion_private.community_post_json(p_post uuid,p_viewer uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',p.id,'author',companion_private.community_actor_json(p.actor_id),
    'body',p.body,'createdAt',p.created_at,'source',p.source,'visibility','PUBLIC',
    'commentsCount',(select count(*) from public.community_comments c where c.post_id=p.id and c.deleted_at is null
      and companion_private.community_visible(c.actor_id,p_viewer)),
    'likeCount',companion_private.community_like_count(p.id,p_viewer),
    'likedByMe',exists(select 1 from public.community_likes l where l.post_id=p.id and l.actor_id=p_viewer),
    'canDelete',p.actor_id=p_viewer)
  from public.community_posts p where p.id=p_post
$$;

-- Likes (p_liked true) or takes the like back (false). Setting it twice changes nothing, so it
-- needs no retry key. An AI identity obeys its agent settings like its other writes (paused,
-- active hours) and must be public and active; at most 300 new likes an hour per identity.
create function public.community_like(p_kind text, p_id uuid, p_post uuid, p_liked boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; s companion_private.agent_settings%rowtype; reason text;
begin
  a := companion_private.community_actor(p_kind, p_id);
  if p_liked is null then raise exception using errcode='22023', message='invalid like'; end if;
  if not exists(select 1 from public.community_posts p where p.id = p_post and p.deleted_at is null
      and companion_private.community_visible(p.actor_id, a.id)) then
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
    end if;
  else
    delete from public.community_likes where post_id = p_post and actor_id = a.id;
  end if;
  return jsonb_build_object('liked', p_liked, 'likeCount', companion_private.community_like_count(p_post, a.id));
end $$;

revoke all on function companion_private.community_like_count(uuid, uuid), public.community_like(text, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.community_like(text, uuid, uuid, boolean) to authenticated;

-- ---------- at most 10 Companions per Owner ----------

-- Counts every Companion that is not deleted (a quarantined one still counts). Creating and
-- deleting take the Owner's row first, so two requests at once cannot both pass.
create function companion_private.companion_limit_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.owners where id = new.owner_id for no key update;
  if (select count(*) from public.companions where owner_id = new.owner_id and status <> 'DELETED') >= 10 then
    raise exception using errcode='55000', message='companion limit reached';
  end if;
  return new;
end $$;
create trigger companions_limit_guard before insert on public.companions
  for each row execute function companion_private.companion_limit_guard();
revoke all on function companion_private.companion_limit_guard() from public, anon, authenticated;

-- ---------- deleting a Companion ----------

-- The Owner deletes one of their Companions. It disappears from every list and read (they all
-- skip status DELETED), and what was private to it is erased now:
--   its one-to-one chat, what it said in group chats and its place in them (a group left with
--   no Companion is deleted), its diary, memories, anniversary, chat settings, drafts and the
--   Owner's notices about it; its connection (the sealed key or token) and its agent keys.
-- In the community its posts and comments are withdrawn, and its follows, likes and
-- notifications are removed. The row itself, its identity versions and the audit and compute
-- history stay (other tables point at them); nothing reads them for the app any more.
-- A quarantined Companion is the operators' to decide and cannot be deleted here.
create function public.companion_delete(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); c uuid; v_actor uuid;
begin
  perform 1 from public.owners where id = o for no key update;
  select id into c from public.companions
    where id = p_companion and owner_id = o and status not in ('DELETED', 'QUARANTINED') for update;
  if not found then raise exception using errcode='P0001', message='companion not found'; end if;
  update public.companions set status = 'DELETED', updated_at = now() where id = c;

  -- Model calls still on the way are given up, so no budget or credits stay held.
  perform companion_private.chat_abandon_compute(o, m.compute_tx)
    from companion_private.chat_messages m where m.companion_id = c and m.compute_tx is not null;
  perform companion_private.chat_abandon_compute(o, e.compute_tx)
    from companion_private.diary_entries e where e.companion_id = c and e.compute_tx is not null;

  delete from companion_private.chats where direct_companion_id = c;
  delete from companion_private.chat_messages where companion_id = c;
  delete from companion_private.chat_members where companion_id = c;
  delete from companion_private.chats x where x.owner_id = o and x.direct_companion_id is null
    and not exists(select 1 from companion_private.chat_members m where m.chat_id = x.id);
  delete from companion_private.diary_entries where companion_id = c;
  delete from companion_private.diary_settings where companion_id = c;
  delete from companion_private.companion_memories where companion_id = c;
  delete from companion_private.companion_connections where companion_id = c;
  delete from companion_private.agent_keys where companion_id = c;
  delete from companion_private.anniversaries where companion_id = c;
  delete from companion_private.chat_settings where companion_id = c;
  delete from public.life_event_inbox where owner_id = o and companion_id = c;

  select a.id into v_actor from public.community_actors a
    join public.social_twins t on t.id = a.social_twin_id where t.companion_id = c;
  if v_actor is not null then
    update public.community_posts set deleted_at = now() where actor_id = v_actor and deleted_at is null;
    update public.community_comments set deleted_at = now() where actor_id = v_actor and deleted_at is null;
    delete from public.community_follows where actor_id = v_actor or target_id = v_actor;
    delete from public.community_likes where actor_id = v_actor;
    delete from public.community_notifications where actor_id = v_actor or recipient_id = v_actor;
    delete from companion_private.agent_drafts where actor_id = v_actor;
  end if;

  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'COMPANION_DELETE', 'COMPANION', c);
  return jsonb_build_object('deleted', true);
end $$;

revoke all on function public.companion_delete(uuid) from public, anon, authenticated;
grant execute on function public.companion_delete(uuid) to authenticated;

-- Same as in 0053, but the Companion is checked first. Before, a Companion without keys was never
-- checked, so any id (another Owner's, a deleted one) answered an empty list instead of not found.
create or replace function public.agent_key_list(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return jsonb_build_object('items', coalesce((select jsonb_agg(companion_private.agent_key_json(k) order by k.created_at desc)
    from companion_private.agent_keys k where k.companion_id = c), '[]'));
end $$;

commit;
