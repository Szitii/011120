begin;

create table public.community_blocks (
  actor_id uuid not null references public.community_actors(id),
  target_id uuid not null references public.community_actors(id),
  created_at timestamptz not null default now(),
  primary key(actor_id,target_id),
  check(actor_id<>target_id)
);
create index community_blocks_target on public.community_blocks(target_id,actor_id);
create table companion_private.community_reports (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.community_actors(id),
  target_actor_id uuid not null references public.community_actors(id),
  target_type text not null check(target_type in ('ACTOR','POST','COMMENT')),
  target_id uuid not null,
  reason text not null check(reason in ('SPAM','HARASSMENT','HARMFUL','PRIVACY','OTHER')),
  details text not null check(char_length(details)<=1000),
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  status text not null default 'SUBMITTED' check(status in ('SUBMITTED','REVIEWED')),
  unique(actor_id,target_type,target_id)
);
create index community_reports_queue on companion_private.community_reports(status,created_at,id);
alter table public.community_blocks enable row level security;
alter table public.community_blocks force row level security;
alter table companion_private.community_reports enable row level security;
alter table companion_private.community_reports force row level security;
revoke all on public.community_blocks,companion_private.community_reports from public,anon,authenticated;

-- Pair locks order block and interaction commands before the actor command lock.
create function companion_private.community_lock_pair(p_left uuid,p_right uuid)
returns void language sql volatile security definer set search_path='' as $$
  select pg_advisory_xact_lock(hashtextextended(least(p_left,p_right)::text||greatest(p_left,p_right)::text,32))
$$;

create function companion_private.community_profile_available(p_actor uuid,p_viewer uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.community_actors a join public.owners o on o.id=a.owner_id
    left join public.social_twins t on t.id=a.social_twin_id
    left join public.companions c on c.id=t.companion_id
    left join public.social_personas s on s.id=t.active_social_persona_id
    where a.id=p_actor and o.status='ACTIVE' and
      (a.kind='HUMAN' or (t.status<>'SUSPENDED' and c.status not in ('DELETED','QUARANTINED')
        and (a.id=p_viewer or s.profile_visibility='PUBLIC'))))
$$;

create or replace function companion_private.community_visible(p_actor uuid,p_viewer uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select companion_private.community_profile_available(p_actor,p_viewer)
    and not exists(select 1 from public.community_blocks
      where (actor_id=p_actor and target_id=p_viewer) or (actor_id=p_viewer and target_id=p_actor))
$$;

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
      'postsCount',(select count(*) from public.community_posts p where p.actor_id=target and p.deleted_at is null));
  elsif p_resource='feed' then
    if p_target is not null and not companion_private.community_visible(p_target,a.id) then raise exception using errcode='P0001',message='profile not found'; end if;
    select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id desc),'[]') into items from (
      select p.created_at,p.id,companion_private.community_post_json(p.id,a.id) item from public.community_posts p
        join public.community_actors ca on ca.id=p.actor_id
      where p.deleted_at is null and companion_private.community_visible(p.actor_id,a.id)
        and (p_target is null or p.actor_id=p_target) and (p_filter='ALL' or ca.kind=p_filter)
        and (p_mode='LATEST' or exists(select 1 from public.community_follows f where f.actor_id=a.id and f.target_id=p.actor_id))
        and (p_before_at is null or (p.created_at,p.id)<(p_before_at,p_before_id))
      order by p.created_at desc,p.id desc limit 21) q;
  elsif p_resource='detail' then
    if not exists(select 1 from public.community_posts p where p.id=p_target and p.deleted_at is null
      and companion_private.community_visible(p.actor_id,a.id)) then raise exception using errcode='P0001',message='post not found'; end if;
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
        'actor',companion_private.community_actor_json(nt.actor_id),'postId',nt.post_id,
        'createdAt',nt.created_at,'readAt',nt.read_at) item from public.community_notifications nt
      where nt.recipient_id=a.id and companion_private.community_visible(nt.actor_id,a.id)
        and (nt.kind='FOLLOW' and exists(select 1 from public.community_follows f where f.actor_id=nt.actor_id and f.target_id=a.id)
          or nt.kind='COMMENT' and exists(select 1 from public.community_posts p join public.community_comments c on c.post_id=p.id
            where p.id=nt.post_id and c.id=nt.comment_id and p.deleted_at is null and c.deleted_at is null
              and companion_private.community_visible(p.actor_id,a.id)))
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

create or replace function public.community_command(p_kind text,p_id uuid,p_action text,p_target uuid,p_body text,p_key text,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; prior companion_private.community_requests%rowtype;
  result jsonb; object_id uuid; recipient uuid; persona uuid; source text; changed integer; fingerprint text; evidence jsonb; target_actor uuid; report_data jsonb; report_row companion_private.community_reports%rowtype;
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
    if (select count(*) from public.community_posts where actor_id=a.id and created_at>now()-interval '1 hour')>=30
      or (select count(*) from public.community_comments where actor_id=a.id and created_at>now()-interval '1 hour')>=100 then
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
      delete from public.community_follows where
        (actor_id=a.id and target_id=p_target) or (actor_id=p_target and target_id=a.id);
      delete from public.community_notifications where
        (actor_id=a.id and recipient_id=p_target) or (actor_id=p_target and recipient_id=a.id);
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

revoke all on function companion_private.community_profile_available(uuid,uuid),
  companion_private.community_lock_pair(uuid,uuid) from public,anon,authenticated;
commit;
