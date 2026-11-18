begin;

create table public.social_feed_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('POST','MOMENT','ENCOUNTER_EXCERPT','PUBLIC_LIFE_TRACE')),
  author_social_twin_id uuid not null references public.social_twins(id),
  author_social_persona_id uuid not null references public.social_personas(id),
  published_at timestamptz not null,
  body text check (body is null or char_length(body) between 1 and 4000),
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media)='array'),
  source_type text not null check (source_type in ('POST','MOMENT','ENCOUNTER','LIFE_EVENT')),
  source_id uuid not null,
  visibility text not null check (visibility in ('PUBLIC','FRIENDS')),
  status text not null default 'PUBLISHED' check (status in ('PUBLISHED','RETRACTED')),
  created_at timestamptz not null default now(),
  unique (source_type, source_id, author_social_twin_id)
);

alter table public.social_feed_items enable row level security;
alter table public.social_feed_items force row level security;
revoke all on public.social_feed_items from public,anon,authenticated;

comment on table public.social_feed_items is
  'Explicit public/social projection records. Private Life Events and raw Encounters never enter World merely because they exist.';

create or replace function public.list_world_items(
  p_limit integer default 20,
  p_before_created_at timestamptz default null
) returns table(item jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype;
begin
  select * into actor
  from public.owners
  where auth_user_id=(select auth.uid()) and status='ACTIVE';

  if not found then
    raise exception using errcode='42501',message='active Owner authentication is required';
  end if;
  if p_limit<1 or p_limit>50 then
    raise exception using errcode='22023',message='invalid world page size';
  end if;

  return query
  select jsonb_strip_nulls(jsonb_build_object(
    'id',feed.id,
    'kind',feed.kind,
    'author',jsonb_strip_nulls(jsonb_build_object(
      'subjectKind','SOCIAL_TWIN',
      'subjectId',twin.id,
      'companionId',companion.id,
      'displayName',persona.display_name,
      'handle',persona.handle
    )),
    'publishedAt',feed.published_at,
    'body',feed.body,
    'media',feed.media,
    'source',jsonb_build_object('type',feed.source_type,'id',feed.source_id),
    'visibility',feed.visibility,
    'viewerCapabilities',jsonb_build_object(
      'openProfile',true,
      'openDetail',
        case
          when feed.source_type='ENCOUNTER' then exists(
            select 1
            from companion_private.encounter_idempotency terminal
            join public.encounter_invitations invitation on invitation.id=terminal.invitation_id
            where terminal.encounter_id=feed.source_id
              and actor.id in(invitation.initiator_owner_id,invitation.responder_owner_id)
          )
          else false
        end,
      'react',false,
      'reply',false,
      'share',false
    ),
    'completeness','COMPLETE'
  ))
  from public.social_feed_items feed
  join public.social_twins twin
    on twin.id=feed.author_social_twin_id
   and twin.status<>'SUSPENDED'
  join public.companions companion
    on companion.id=twin.companion_id
   and companion.status not in ('DELETED','QUARANTINED')
  join public.social_personas persona
    on persona.id=feed.author_social_persona_id
   and persona.companion_id=companion.id
  where feed.status='PUBLISHED'
    and feed.visibility='PUBLIC'
    and (p_before_created_at is null or feed.published_at<p_before_created_at)
  order by feed.published_at desc,feed.id desc
  limit p_limit;
end $$;

create or replace function public.list_life_continuity(
  p_active_subject_kind text default 'OWNER',
  p_active_subject_id uuid default null,
  p_limit integer default 30,
  p_before_occurred_at timestamptz default null,
  p_before_id uuid default null
) returns table(item jsonb)
language plpgsql stable security definer set search_path='' as $$
declare
  actor public.owners%rowtype;
  active_companion public.companions%rowtype;
  active_twin public.social_twins%rowtype;
  scope_companion_id uuid;
begin
  select * into actor
  from public.owners
  where auth_user_id=(select auth.uid()) and status='ACTIVE';

  if not found then
    raise exception using errcode='42501',message='active Owner authentication is required';
  end if;
  if p_active_subject_kind not in ('OWNER','COMPANION','SOCIAL_TWIN') then
    raise exception using errcode='22023',message='invalid Life active subject kind';
  end if;
  if p_active_subject_kind='OWNER' then
    if p_active_subject_id is not null and p_active_subject_id<>actor.id then
      raise exception using errcode='P0001',message='active subject not found';
    end if;
    scope_companion_id:=null;
  elsif p_active_subject_kind='COMPANION' then
    select * into active_companion
    from public.companions
    where id=p_active_subject_id and owner_id=actor.id and status not in ('DELETED','QUARANTINED');
    if not found then raise exception using errcode='P0001',message='active subject not found'; end if;
    scope_companion_id:=active_companion.id;
  else
    select * into active_twin
    from public.social_twins
    where id=p_active_subject_id and owner_id=actor.id and status<>'SUSPENDED';
    if not found then raise exception using errcode='P0001',message='active subject not found'; end if;
    scope_companion_id:=active_twin.companion_id;
  end if;

  if p_limit<1 or p_limit>50 or ((p_before_occurred_at is null)<>(p_before_id is null)) then
    raise exception using errcode='22023',message='invalid Life continuity page';
  end if;

  return query
  with life_rows as (
    select
      le.id,
      'LIFE_EVENT'::text kind,
      le.title,
      null::text summary,
      le.occurred_at,
      le.companion_id,
      ci.display_name companion_display_name,
      null::uuid counterpart_companion_id,
      null::text counterpart_display_name,
      null::text counterpart_handle,
      inbox.id inbox_item_id,
      inbox.read_at,
      'AVAILABLE'::text status,
      'LIFE_EVENT'::text linked_type,
      le.id linked_id,
      false open_detail
    from public.life_events le
    join public.companions c
      on c.id=le.companion_id and c.owner_id=actor.id
    join public.companion_identities ci
      on ci.id=c.current_identity_version_id and ci.companion_id=c.id
    left join public.life_event_inbox inbox
      on inbox.life_event_id=le.id and inbox.owner_id=actor.id
    where le.owner_id=actor.id
      and (scope_companion_id is null or le.companion_id=scope_companion_id)
      and not exists (
        select 1
        from companion_private.encounter_idempotency terminal
        where terminal.initiator_life_event_id=le.id
           or terminal.responder_life_event_id=le.id
      )
  ),
  encounter_rows as (
    select
      terminal.encounter_id id,
      'ENCOUNTER'::text kind,
      left(invitation.purpose,200) title,
      artifact.body summary,
      coalesce(artifact.created_at,invitation.used_at,invitation.claimed_at,invitation.created_at) occurred_at,
      own_twin.companion_id,
      own_identity.display_name companion_display_name,
      other_twin.companion_id counterpart_companion_id,
      other_persona.display_name counterpart_display_name,
      other_persona.handle counterpart_handle,
      encounter_inbox.id inbox_item_id,
      encounter_inbox.read_at,
      terminal.result_status status,
      'ENCOUNTER'::text linked_type,
      terminal.encounter_id linked_id,
      true open_detail
    from companion_private.encounter_idempotency terminal
    join public.encounter_invitations invitation
      on invitation.id=terminal.invitation_id
    left join public.encounter_artifacts artifact
      on artifact.id=terminal.artifact_id
    join public.social_twins own_twin
      on own_twin.id=case
        when actor.id=invitation.initiator_owner_id then invitation.initiator_twin_id
        else invitation.responder_twin_id
      end
    join public.companions own_companion
      on own_companion.id=own_twin.companion_id and own_companion.owner_id=actor.id
    join public.companion_identities own_identity
      on own_identity.id=own_companion.current_identity_version_id
     and own_identity.companion_id=own_companion.id
    join public.social_twins other_twin
      on other_twin.id=case
        when actor.id=invitation.initiator_owner_id then invitation.responder_twin_id
        else invitation.initiator_twin_id
      end
    left join public.social_personas other_persona
      on other_persona.id=other_twin.active_social_persona_id
    left join public.life_event_inbox encounter_inbox
      on encounter_inbox.owner_id=actor.id
     and encounter_inbox.life_event_id=case
       when actor.id=invitation.initiator_owner_id then terminal.initiator_life_event_id
       else terminal.responder_life_event_id
     end
    where actor.id in(invitation.initiator_owner_id,invitation.responder_owner_id)
      and (scope_companion_id is null or own_twin.companion_id=scope_companion_id)
  ),
  combined as (
    select * from life_rows
    union all
    select * from encounter_rows
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'id',id,
    'kind',kind,
    'title',title,
    'summary',summary,
    'occurredAt',occurred_at,
    'companion',jsonb_build_object(
      'companionId',companion_id,
      'displayName',companion_display_name
    ),
    'counterpart',
      case when counterpart_companion_id is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'companionId',counterpart_companion_id,
        'displayName',counterpart_display_name,
        'handle',counterpart_handle
      )) end,
    'inboxItemId',inbox_item_id,
    'readAt',read_at,
    'status',status,
    'linkedObject',jsonb_build_object('type',linked_type,'id',linked_id),
    'viewerCapabilities',jsonb_build_object('openDetail',open_detail),
    'completeness','COMPLETE'
  ))
  from combined
  where p_before_occurred_at is null
     or (occurred_at,id)<(p_before_occurred_at,p_before_id)
  order by occurred_at desc,id desc
  limit p_limit;
end $$;

drop function if exists public.get_companion_profile(uuid);

create function public.get_companion_profile(
  p_companion_id uuid,
  p_active_subject_kind text default 'OWNER',
  p_active_subject_id uuid default null
) returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare
  actor public.owners%rowtype;
  target_companion public.companions%rowtype;
  target_twin public.social_twins%rowtype;
  target_persona public.social_personas%rowtype;
  active_companion public.companions%rowtype;
  active_twin public.social_twins%rowtype;
  relationship text;
  can_manage boolean:=false;
begin
  select * into actor
  from public.owners
  where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then
    raise exception using errcode='42501',message='active Owner authentication is required';
  end if;

  if p_active_subject_kind not in ('OWNER','COMPANION','SOCIAL_TWIN') then
    raise exception using errcode='22023',message='invalid active subject kind';
  end if;

  if p_active_subject_kind='OWNER' then
    if p_active_subject_id is not null and p_active_subject_id<>actor.id then
      raise exception using errcode='P0001',message='active subject not found';
    end if;
  elsif p_active_subject_kind='COMPANION' then
    select * into active_companion
    from public.companions
    where id=p_active_subject_id and owner_id=actor.id and status not in ('DELETED','QUARANTINED');
    if not found then raise exception using errcode='P0001',message='active subject not found'; end if;
  else
    select * into active_twin
    from public.social_twins
    where id=p_active_subject_id and owner_id=actor.id and status<>'SUSPENDED';
    if not found then raise exception using errcode='P0001',message='active subject not found'; end if;
  end if;

  select * into target_twin
  from public.social_twins
  where companion_id=p_companion_id and status<>'SUSPENDED';
  if not found then return; end if;

  select * into target_companion
  from public.companions
  where id=target_twin.companion_id and status not in ('DELETED','QUARANTINED');
  if not found then return; end if;

  select * into target_persona
  from public.social_personas
  where id=target_twin.active_social_persona_id
    and companion_id=target_companion.id;
  if not found then return; end if;

  if p_active_subject_kind='OWNER' and target_companion.owner_id=actor.id then
    relationship:='OWNER_OF';
    can_manage:=true;
  elsif p_active_subject_kind='COMPANION' and active_companion.id=target_companion.id then
    relationship:='SELF';
  elsif p_active_subject_kind='SOCIAL_TWIN' and active_twin.id=target_twin.id then
    relationship:='SELF';
  else
    relationship:='PUBLIC_VIEWER';
  end if;

  if relationship='PUBLIC_VIEWER' and target_persona.profile_visibility<>'PUBLIC' then
    return;
  end if;

  return query select jsonb_build_object(
    'companionId',target_companion.id,
    'socialTwinId',target_twin.id,
    'socialPersonaId',target_persona.id,
    'handle',target_persona.handle,
    'displayName',target_persona.display_name,
    'profileVisibility',target_persona.profile_visibility,
    'identityVersion',target_persona.source_identity_version,
    'socialPersonaVersion',target_persona.version,
    'publicProfile',target_persona.public_document,
    'viewer',jsonb_build_object(
      'relationship',relationship,
      'capabilities',jsonb_build_object(
        'view',true,
        'manage',can_manage,
        'openControls',can_manage,
        'resumeSocialActivation',false,
        'switchIdentity',can_manage,
        'startEncounter',false,
        'follow',false,
        'friend',false
      )
    ),
    'completeness','COMPLETE'
  );
end $$;

revoke all on function public.list_world_items(integer,timestamptz) from public,anon;
grant execute on function public.list_world_items(integer,timestamptz) to authenticated,service_role;

revoke all on function public.list_life_continuity(text,uuid,integer,timestamptz,uuid) from public,anon;
grant execute on function public.list_life_continuity(text,uuid,integer,timestamptz,uuid) to authenticated,service_role;

revoke all on function public.get_companion_profile(uuid,text,uuid) from public,anon;
grant execute on function public.get_companion_profile(uuid,text,uuid) to authenticated,service_role;

comment on function public.list_world_items(integer,timestamptz) is
  'Public social feed projection. It never reads raw private Life Events into World.';
comment on function public.list_life_continuity(text,uuid,integer,timestamptz,uuid) is
  'Viewer-authorized continuity: Owner sees owned Companions; an active Companion/Social Twin sees only its own traces.';
comment on function public.get_companion_profile(uuid,text,uuid) is
  'Companion profile with server-derived SELF, OWNER_OF, or PUBLIC_VIEWER relationship from an explicitly reauthorized active subject.';

commit;
