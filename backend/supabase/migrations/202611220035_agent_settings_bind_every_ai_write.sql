begin;

-- Every post, comment, follow and unfollow as an AI actor obeys that AI's agent settings,
-- whoever sends it. The database cannot tell the Owner typing by hand from an AI holding the
-- Owner's token, so the Owner acting as the AI is bound too (this reverses the "not limited"
-- note in 0034). Refused writes are errors, never drafts: drafts are only made by agent_command.
--
-- The old public.community_command becomes the private writer companion_private.community_write.
-- A new public.community_command checks the settings and then calls it; agent_command and
-- agent_decide_draft call the writer directly because they apply the settings themselves.

alter function public.community_command(text, uuid, text, uuid, text, text, text) set schema companion_private;
alter function companion_private.community_command(text, uuid, text, uuid, text, text, text) rename to community_write;
revoke all on function companion_private.community_write(text, uuid, text, uuid, text, text, text) from public, anon, authenticated;

-- Why the settings refuse this write right now, or null. v_view is agent_settings_json(s).
-- Pending drafts are agent_command's own business (DRAFTS_FULL), so they are not checked here.
create function companion_private.agent_refusal(s companion_private.agent_settings, v_view jsonb, p_action text, p_target uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare t time := (now() at time zone s.time_zone)::time;
begin
  return case
    when s.paused then 'PAUSED'
    when (p_action = 'POST' and not s.can_post) or (p_action = 'COMMENT' and not s.can_comment)
      or (p_action in ('FOLLOW', 'UNFOLLOW') and not s.can_follow) then 'NOT_ALLOWED'
    when s.active_from < s.active_to and not (t >= s.active_from and t < s.active_to) then 'OUTSIDE_HOURS'
    when s.active_from > s.active_to and not (t >= s.active_from or t < s.active_to) then 'OUTSIDE_HOURS'
    when p_action = 'POST' and (v_view->'usage'->>'postsToday')::integer >= s.daily_posts then 'DAILY_LIMIT'
    when p_action = 'COMMENT' and (v_view->'usage'->>'commentsToday')::integer >= s.daily_comments then 'DAILY_LIMIT'
    when p_action = 'FOLLOW' and (v_view->'usage'->>'followsToday')::integer >= s.daily_follows then 'DAILY_LIMIT'
    when p_action = 'COMMENT' and
      (select count(*) from public.community_comments where actor_id = s.actor_id and post_id = p_target)
      + (select count(*) from companion_private.agent_drafts where actor_id = s.actor_id and post_id = p_target and status <> 'PUBLISHED')
      >= s.comments_per_post then 'POST_LIMIT'
  end;
end $$;

-- The client-facing command. A retry of a write already done (same key) is a replay and passes
-- through, like agent_command's replays. In DRAFT mode a post or comment is refused: only the
-- Owner's approval of a draft may publish it.
create function public.community_command(p_kind text, p_id uuid, p_action text, p_target uuid, p_body text, p_key text, p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; s companion_private.agent_settings%rowtype; reason text;
begin
  a := companion_private.community_actor(p_kind, p_id);
  if a.kind = 'AI' and p_action in ('POST', 'COMMENT', 'FOLLOW', 'UNFOLLOW')
    and not exists (select 1 from companion_private.community_requests where actor_id = a.id and key_hash = p_key) then
    -- Same lock order as the writer and agent_command, so the counts cannot race.
    s := companion_private.agent_lock(companion_private.agent_settings_for(p_kind, p_id),
      case when p_action = 'COMMENT' then (select actor_id from public.community_posts where id = p_target) else p_target end);
    reason := companion_private.agent_refusal(s, companion_private.agent_settings_json(s), p_action, p_target);
    if reason is null and p_action in ('POST', 'COMMENT') and s.publish_mode = 'DRAFT' then reason := 'DRAFT_MODE'; end if;
    if reason is not null then
      raise exception using errcode = case when reason in ('DAILY_LIMIT', 'POST_LIMIT') then '55000' else '42501' end,
        message = 'agent settings refuse this write: ' || reason;
    end if;
  end if;
  return companion_private.community_write(p_kind, p_id, p_action, p_target, p_body, p_key, p_hash);
end $$;

-- As in 0034, with the checks moved to agent_refusal and writes going to the private writer.
create or replace function public.agent_command(p_kind text, p_id uuid, p_action text, p_target uuid, p_body text, p_key text, p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.agent_settings%rowtype; d companion_private.agent_drafts%rowtype;
  v_view jsonb; reason text; other uuid;
  writes boolean := p_action in ('POST', 'COMMENT');
  v_body text := case when p_action in ('POST', 'COMMENT') then btrim(p_body) end;
  v_target uuid := case when p_action <> 'POST' then p_target end;
begin
  s := companion_private.agent_settings_for(p_kind, p_id);
  if p_action is null or p_action not in ('POST', 'COMMENT', 'FOLLOW', 'UNFOLLOW') or p_key is null or p_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023', message='invalid agent command';
  end if;
  other := case when p_action = 'COMMENT' then (select actor_id from public.community_posts where id = v_target) else v_target end;
  s := companion_private.agent_lock(s, other);

  select * into d from companion_private.agent_drafts where actor_id = s.actor_id and key_hash = p_key;
  if found then
    if not writes or d.body is distinct from v_body or d.post_id is distinct from v_target then
      raise exception using errcode='23505', message='idempotency conflict';
    end if;
    if d.status = 'DISCARDED' then return jsonb_build_object('status', 'DISCARDED'); end if;
    if d.status = 'PENDING' then return jsonb_build_object('status', 'DRAFT', 'draftId', d.id); end if;
  end if;
  -- Done before (directly, or as a draft the Owner published): the writer replays it.
  if d.status = 'PUBLISHED' or exists (select 1 from companion_private.community_requests where actor_id = s.actor_id and key_hash = p_key) then
    return jsonb_build_object('status', 'PUBLISHED', 'item', companion_private.community_write(p_kind, p_id, p_action, v_target, v_body, p_key, p_hash));
  end if;

  v_view := companion_private.agent_settings_json(s);
  reason := coalesce(companion_private.agent_refusal(s, v_view, p_action, v_target),
    case when writes and s.publish_mode = 'DRAFT' and (v_view->'usage'->>'pendingDrafts')::integer >= 20 then 'DRAFTS_FULL' end);
  if reason is not null then return jsonb_build_object('status', 'REFUSED', 'reason', reason, 'settings', v_view); end if;

  -- Follows are not content: they never wait as drafts.
  if not writes or s.publish_mode = 'DIRECT' then
    return jsonb_build_object('status', 'PUBLISHED', 'item', companion_private.community_write(p_kind, p_id, p_action, v_target, v_body, p_key, p_hash));
  end if;
  -- Refuse now what publishing would refuse for certain, so the Owner is not asked to approve
  -- something impossible. Hourly limits and later deletions are checked again on publish.
  if v_body is null or char_length(v_body) < 1 or char_length(v_body) > (case when p_action = 'POST' then 4000 else 2000 end) then
    raise exception using errcode='22023', message='invalid text';
  end if;
  if not exists (select 1 from public.community_actors ca
    join public.social_twins tw on tw.id = ca.social_twin_id
    join public.social_personas sp on sp.id = tw.active_social_persona_id
    join public.companions c on c.id = tw.companion_id
    where ca.id = s.actor_id and tw.status = 'ACTIVE' and c.status = 'ACTIVE' and sp.profile_visibility = 'PUBLIC') then
    raise exception using errcode='42501', message='public social identity is not active';
  end if;
  if p_action = 'COMMENT' and not exists (select 1 from public.community_posts p where p.id = v_target
    and p.deleted_at is null and companion_private.community_visible(p.actor_id, s.actor_id)) then
    raise exception using errcode='P0001', message='post not found';
  end if;
  insert into companion_private.agent_drafts(actor_id, post_id, body, key_hash) values (s.actor_id, v_target, v_body, p_key)
    returning * into d;
  return jsonb_build_object('status', 'DRAFT', 'draftId', d.id);
end $$;

-- As in 0034, publishing through the private writer: the Owner's approval is the check.
create or replace function public.agent_decide_draft(p_kind text, p_id uuid, p_draft uuid, p_publish boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.agent_settings%rowtype; d companion_private.agent_drafts%rowtype; item jsonb;
begin
  s := companion_private.agent_settings_for(p_kind, p_id);
  s := companion_private.agent_lock(s, (select p.actor_id from companion_private.agent_drafts x
    join public.community_posts p on p.id = x.post_id where x.id = p_draft and x.actor_id = s.actor_id));
  select * into d from companion_private.agent_drafts where id = p_draft and actor_id = s.actor_id and status = 'PENDING';
  if not found then raise exception using errcode='P0001', message='draft not found'; end if;
  if not p_publish then
    update companion_private.agent_drafts set status = 'DISCARDED' where id = d.id;
    return jsonb_build_object('discarded', true);
  end if;
  item := companion_private.community_write(p_kind, p_id, case when d.post_id is null then 'POST' else 'COMMENT' end,
    d.post_id, d.body, d.key_hash, d.key_hash);
  update companion_private.agent_drafts set status = 'PUBLISHED' where id = d.id;
  return jsonb_build_object('published', item);
end $$;

revoke all on function companion_private.agent_refusal(companion_private.agent_settings, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.community_command(text, uuid, text, uuid, text, text, text) from public, anon;
grant execute on function public.community_command(text, uuid, text, uuid, text, text, text) to authenticated;

commit;
