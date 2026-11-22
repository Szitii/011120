begin;

-- Review fixes. Each function is its latest definition with one change:
-- 1. community_write (0032 body, renamed in 0035): the hourly cap was shared, so 30 posts in an
--    hour also refused comments and 100 comments refused posts. Each action has its own cap now.
-- 2. community_write: BLOCK removed follows and notifications only with the one blocked actor,
--    while 0038 hides every actor of that person. The cleanup now covers the same set, so an
--    unblock does not bring back a hidden follow of the person's other identity.
-- 3. agent_refusal: discarded drafts counted toward the per-post comment cap forever. Only
--    comments and pending drafts count now.
-- 4. agent_decide_draft: a null p_publish fell through to publishing. It is refused now.

create or replace function companion_private.community_write(p_kind text,p_id uuid,p_action text,p_target uuid,p_body text,p_key text,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; prior companion_private.community_requests%rowtype;
  result jsonb; object_id uuid; recipient uuid; persona uuid; source text; changed integer; fingerprint text; evidence jsonb; target_actor uuid; report_data jsonb; report_row companion_private.community_reports%rowtype; target_owner uuid;
begin
  a:=companion_private.community_actor(p_kind,p_id);
  if p_action in ('FOLLOW','UNFOLLOW','BLOCK','UNBLOCK','REPORT_ACTOR') then target_actor:=p_target;
  elsif p_action in ('COMMENT','REPORT_POST') then
    select actor_id into target_actor from public.community_posts where id=p_target;
  elsif p_action='REPORT_COMMENT' then
    select actor_id into target_actor from public.community_comments where id=p_target;
  end if;
  if target_actor is not null then perform companion_private.community_lock_pair(a.id,target_actor); end if;
  -- Serialize each actor's commands: retries, notification deduplication and rate limits
  -- share the same transaction as content, audit and idempotency result writes.
  perform 1 from public.community_actors where id=a.id for update;
  if p_key is null or p_hash is null or p_key !~ '^[a-f0-9]{64}$' or p_hash !~ '^[a-f0-9]{64}$'
    or p_action is null or p_action not in ('POST','COMMENT','FOLLOW','UNFOLLOW','DELETE_POST','DELETE_COMMENT','READ_NOTIFICATION','BLOCK','UNBLOCK','REPORT_ACTOR','REPORT_POST','REPORT_COMMENT') then
    raise exception using errcode='22023',message='invalid command'; end if;
  -- Public RPC callers cannot bypass conflict checks by supplying a forged request hash.
  fingerprint:=encode(public.digest(jsonb_build_object('action',p_action,'target',p_target,'body',p_body)::text,'sha256'),'hex');
  -- A retry cannot bypass a subsequent autonomy/profile revocation.
  if a.kind='AI' and p_action in ('POST','COMMENT','FOLLOW') then
    select s.id into persona from public.social_twins t join public.social_personas s on s.id=t.active_social_persona_id
      join public.companions c on c.id=t.companion_id where t.id=a.social_twin_id
        and t.status='ACTIVE' and c.status='ACTIVE' and s.profile_visibility='PUBLIC';
    if not found then raise exception using errcode='42501',message='public social identity is not active'; end if;
  end if;
  if p_action='FOLLOW' and not companion_private.community_visible(p_target,a.id) then
    raise exception using errcode='P0001',message='profile not found';
  end if;
  if p_action='COMMENT' and not exists(select 1 from public.community_posts
    where id=p_target and deleted_at is null and companion_private.community_visible(actor_id,a.id)) then
    raise exception using errcode='P0001',message='post not found';
  end if;
  if p_action='READ_NOTIFICATION' and not exists(select 1 from public.community_notifications
    where id=p_target and recipient_id=a.id and companion_private.community_visible(actor_id,a.id)) then
    raise exception using errcode='P0001',message='notification not found';
  end if;
  select * into prior from companion_private.community_requests where actor_id=a.id and key_hash=p_key;
  if found then
    if prior.request_hash<>fingerprint then raise exception using errcode='23505',message='idempotency conflict'; end if;
    -- Do not replay withdrawn text or text whose target is no longer accessible.
    if p_action='POST' and not exists(select 1 from public.community_posts p where p.id=(prior.response->>'id')::uuid and p.deleted_at is null) then
      raise exception using errcode='P0001',message='post withdrawn'; end if;
    if p_action='COMMENT' and not exists(select 1 from public.community_posts p join public.community_comments c on c.post_id=p.id
      where c.id=(prior.response->>'id')::uuid and p.deleted_at is null and c.deleted_at is null and companion_private.community_visible(p.actor_id,a.id)) then
      raise exception using errcode='P0001',message='comment withdrawn'; end if;
    if p_action='POST' then return companion_private.community_post_json((prior.response->>'id')::uuid,a.id); end if;
    if p_action='COMMENT' then return companion_private.community_comment_json((prior.response->>'id')::uuid,a.id); end if;
    if p_action in ('BLOCK','UNBLOCK') then return jsonb_build_object('blocked',
      exists(select 1 from public.community_blocks where actor_id=a.id and target_id=p_target)); end if;
    if p_action in ('FOLLOW','UNFOLLOW') then return jsonb_build_object('following',
      exists(select 1 from public.community_follows where actor_id=a.id and target_id=p_target)); end if;
    return prior.response;
  end if;
  source:=case when a.kind='HUMAN' then 'HUMAN_MANUAL' else 'OWNER_PROXY' end;
  if p_action in ('POST','COMMENT') then
    if p_body is null or char_length(btrim(p_body))<1 or char_length(p_body)>(case when p_action='POST' then 4000 else 2000 end) then
      raise exception using errcode='22023',message='invalid text'; end if;
    if (p_action='POST' and (select count(*) from public.community_posts where actor_id=a.id and created_at>now()-interval '1 hour')>=30)
      or (p_action='COMMENT' and (select count(*) from public.community_comments where actor_id=a.id and created_at>now()-interval '1 hour')>=100) then
      raise exception using errcode='55000',message='community publication limit reached'; end if;
    if p_action='POST' then
      insert into public.community_posts(actor_id,body,source,social_persona_id) values(a.id,btrim(p_body),source,persona) returning id into object_id;
      result:=companion_private.community_post_json(object_id,a.id);
    else
      select actor_id into recipient from public.community_posts p where p.id=p_target and p.deleted_at is null
        and companion_private.community_visible(p.actor_id,a.id) for update;
      if not found then raise exception using errcode='P0001',message='post not found'; end if;
      insert into public.community_comments(post_id,actor_id,body,source,social_persona_id) values(p_target,a.id,btrim(p_body),source,persona) returning id into object_id;
      if recipient<>a.id then insert into public.community_notifications(recipient_id,actor_id,kind,post_id,comment_id)
        values(recipient,a.id,'COMMENT',p_target,object_id); end if;
      result:=companion_private.community_comment_json(object_id,a.id);
    end if;
  elsif p_action in ('FOLLOW','UNFOLLOW') then
    object_id:=p_target;
    if p_target=a.id then raise exception using errcode='22023',message='cannot follow self'; end if;
    if p_action='FOLLOW' then
      if not companion_private.community_visible(p_target,a.id) then raise exception using errcode='P0001',message='profile not found'; end if;
      if (select count(*) from public.audit_events where actor_id=a.id and action='COMMUNITY_FOLLOW' and occurred_at>now()-interval '1 day')>=200 then
        raise exception using errcode='55000',message='community follow limit reached'; end if;
      insert into public.community_follows(actor_id,target_id) values(a.id,p_target) on conflict do nothing;
      get diagnostics changed=row_count;
      if changed>0 then insert into public.community_notifications(recipient_id,actor_id,kind) values(p_target,a.id,'FOLLOW') on conflict do nothing; end if;
    else
      delete from public.community_follows where actor_id=a.id and target_id=p_target;
      delete from public.community_notifications where recipient_id=p_target and actor_id=a.id and kind='FOLLOW';
    end if;
    result:=jsonb_build_object('following',p_action='FOLLOW');
  elsif p_action in ('BLOCK','UNBLOCK') then
    object_id:=p_target;
    if p_target=a.id or p_target is null then
      raise exception using errcode='22023',message='cannot block self'; end if;
    if p_action='BLOCK' then
      if not exists(select 1 from public.community_blocks where actor_id=a.id and target_id=p_target)
        and not companion_private.community_visible(p_target,a.id) then
        raise exception using errcode='P0001',message='profile not found'; end if;
      insert into public.community_blocks(actor_id,target_id) values(a.id,p_target) on conflict do nothing;
      -- As in community_visible (0038), a block covers every actor of the blocked person.
      select owner_id into target_owner from public.community_actors where id=p_target;
      delete from public.community_follows f using public.community_actors t
        where (t.id=p_target or (t.owner_id=target_owner and target_owner<>a.owner_id))
          and ((f.actor_id=a.id and f.target_id=t.id) or (f.actor_id=t.id and f.target_id=a.id));
      delete from public.community_notifications n using public.community_actors t
        where (t.id=p_target or (t.owner_id=target_owner and target_owner<>a.owner_id))
          and ((n.actor_id=a.id and n.recipient_id=t.id) or (n.actor_id=t.id and n.recipient_id=a.id));
    else
      delete from public.community_blocks where actor_id=a.id and target_id=p_target;
    end if;
    result:=jsonb_build_object('blocked',p_action='BLOCK');
  elsif p_action in ('REPORT_ACTOR','REPORT_POST','REPORT_COMMENT') then
    report_data:=p_body::jsonb;
    if report_data is null or jsonb_typeof(report_data)<>'object'
      or not (report_data ? 'reason' and report_data ? 'details')
      or (report_data - 'reason' - 'details')<>'{}'::jsonb
      or jsonb_typeof(report_data->'reason')<>'string' or jsonb_typeof(report_data->'details')<>'string'
      or (report_data->>'reason') not in ('SPAM','HARASSMENT','HARMFUL','PRIVACY','OTHER')
      or char_length(report_data->>'details')>1000 then
      raise exception using errcode='22023',message='invalid report'; end if;
    -- A replay can acknowledge a report after withdrawal without returning its text.
    select * into report_row from companion_private.community_reports
      where actor_id=a.id and target_type=substr(p_action,8) and target_id=p_target;
    if found then
      result:=jsonb_build_object('id',report_row.id,'status','SUBMITTED');
    else
      if target_actor=a.id or target_actor is null or not companion_private.community_visible(target_actor,a.id) then
        raise exception using errcode='P0001',message='report target not found'; end if;
      if p_action='REPORT_POST' and not exists(select 1 from public.community_posts where id=p_target and deleted_at is null) then
        raise exception using errcode='P0001',message='post not found'; end if;
      if p_action='REPORT_COMMENT' and not exists(select 1 from public.community_comments c
        join public.community_posts p on p.id=c.post_id where c.id=p_target and c.deleted_at is null
        and p.deleted_at is null and companion_private.community_visible(p.actor_id,a.id)) then
        raise exception using errcode='P0001',message='comment not found'; end if;
      if (select count(*) from companion_private.community_reports where actor_id=a.id and created_at>now()-interval '1 day')>=20 then
        raise exception using errcode='55000',message='report limit reached'; end if;
      if p_action='REPORT_ACTOR' then evidence:=companion_private.community_actor_json(p_target);
      elsif p_action='REPORT_POST' then
        select jsonb_build_object('body',p.body,'source',p.source,'createdAt',p.created_at) into evidence
          from public.community_posts p where p.id=p_target and p.deleted_at is null for share;
        if not found then raise exception using errcode='P0001',message='post not found'; end if;
      else
        select jsonb_build_object('body',p.body,'source',p.source,'createdAt',p.created_at) into evidence
          from public.community_comments p where p.id=p_target and p.deleted_at is null for share;
        if not found then raise exception using errcode='P0001',message='comment not found'; end if;
      end if;
      insert into companion_private.community_reports(actor_id,target_actor_id,target_type,target_id,reason,details,evidence)
        values(a.id,target_actor,substr(p_action,8),p_target,report_data->>'reason',btrim(report_data->>'details'),evidence)
        returning * into report_row;
      result:=jsonb_build_object('id',report_row.id,'status','SUBMITTED');
    end if;
    object_id:=report_row.id;
  elsif p_action='DELETE_POST' then
    object_id:=p_target;
    update public.community_posts set deleted_at=coalesce(deleted_at,now()),body='[已删除]' where id=p_target and actor_id=a.id;
    if not found then raise exception using errcode='P0001',message='post not found'; end if;
    result:=jsonb_build_object('deleted',true);
  elsif p_action='DELETE_COMMENT' then
    object_id:=p_target;
    update public.community_comments set deleted_at=coalesce(deleted_at,now()),body='[已删除]' where id=p_target and actor_id=a.id;
    if not found then raise exception using errcode='P0001',message='comment not found'; end if;
    result:=jsonb_build_object('deleted',true);
  else
    object_id:=p_target;
    update public.community_notifications set read_at=coalesce(read_at,now()) where id=p_target and recipient_id=a.id;
    if not found then raise exception using errcode='P0001',message='notification not found'; end if;
    result:=jsonb_build_object('read',true);
  end if;
  insert into public.audit_events(owner_id,actor_type,actor_id,action,target_type,target_id,reason,request_id)
    values(a.owner_id,a.kind,a.id,'COMMUNITY_'||p_action,'COMMUNITY',object_id,source,p_key);
  -- Deleted text is not retained in replay storage. Keep ids for dynamic serialization instead.
  insert into companion_private.community_requests(actor_id,key_hash,request_hash,response)
    values(a.id,p_key,fingerprint,case when p_action in ('POST','COMMENT') then jsonb_build_object('id',object_id,'contentKind',p_action) else result end);
  return result;
end $$;

create or replace function companion_private.agent_refusal(s companion_private.agent_settings, v_view jsonb, p_action text, p_target uuid)
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
      + (select count(*) from companion_private.agent_drafts where actor_id = s.actor_id and post_id = p_target and status = 'PENDING')
      >= s.comments_per_post then 'POST_LIMIT'
  end;
end $$;

create or replace function public.agent_decide_draft(p_kind text, p_id uuid, p_draft uuid, p_publish boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.agent_settings%rowtype; d companion_private.agent_drafts%rowtype; item jsonb;
begin
  s := companion_private.agent_settings_for(p_kind, p_id);
  s := companion_private.agent_lock(s, (select p.actor_id from companion_private.agent_drafts x
    join public.community_posts p on p.id = x.post_id where x.id = p_draft and x.actor_id = s.actor_id));
  select * into d from companion_private.agent_drafts where id = p_draft and actor_id = s.actor_id and status = 'PENDING';
  if not found then raise exception using errcode='P0001', message='draft not found'; end if;
  if p_publish is null then raise exception using errcode='22023', message='publish or discard'; end if;
  if not p_publish then
    update companion_private.agent_drafts set status = 'DISCARDED' where id = d.id;
    return jsonb_build_object('discarded', true);
  end if;
  item := companion_private.community_write(p_kind, p_id, case when d.post_id is null then 'POST' else 'COMMENT' end,
    d.post_id, d.body, d.key_hash, d.key_hash);
  update companion_private.agent_drafts set status = 'PUBLISHED' where id = d.id;
  return jsonb_build_object('published', item);
end $$;

commit;
