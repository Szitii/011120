begin;

create table public.companion_controls (
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  schema_version integer not null default 1 check (schema_version=1),
  revision bigint not null default 1 check (revision>0),
  social_twin_visibility text not null check (social_twin_visibility in ('PRIVATE','FRIENDS','PUBLIC')),
  social_autonomy_mode text not null check (social_autonomy_mode in ('QUIET','NORMAL','ACTIVE','CUSTOM')),
  memory_sharing_scope text not null default 'PERMISSION_GATED_SOCIAL_ONLY'
    check (memory_sharing_scope='PERMISSION_GATED_SOCIAL_ONLY'),
  notifications_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key(owner_id,companion_id),
  foreign key(companion_id,owner_id) references public.companions(id,owner_id)
);

create table companion_private.controls_idempotency (
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  idempotency_key_hash text not null check (idempotency_key_hash~'^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash~'^[a-f0-9]{64}$'),
  result_revision bigint not null check (result_revision>0),
  result_payload jsonb not null check (jsonb_typeof(result_payload)='object'),
  created_at timestamptz not null default now(),
  primary key(owner_id,idempotency_key_hash),
  foreign key(companion_id,owner_id) references public.companions(id,owner_id)
);

alter table public.companion_controls enable row level security;
alter table public.companion_controls force row level security;
create policy companion_controls_select_owned on public.companion_controls
for select to authenticated using (
  exists(select 1 from public.owners o where o.id=companion_controls.owner_id and o.auth_user_id=(select auth.uid()) and o.status='ACTIVE')
);
revoke insert,update,delete on public.companion_controls from anon,authenticated;
revoke all on table companion_private.controls_idempotency from public,anon,authenticated;
create trigger controls_idempotency_immutable before update or delete on companion_private.controls_idempotency
for each row execute function companion_private.reject_immutable_mutation();

create or replace function companion_private.ensure_companion_controls(p_owner_id uuid,p_companion_id uuid)
returns public.companion_controls
language plpgsql security definer set search_path='' as $$
declare result public.companion_controls%rowtype; twin public.social_twins%rowtype; persona public.social_personas%rowtype;
begin
  if not exists(select 1 from public.companions where id=p_companion_id and owner_id=p_owner_id and status<>'DELETED') then
    raise exception using errcode='P0001',message='companion not found for Owner';
  end if;
  select * into twin from public.social_twins where companion_id=p_companion_id and owner_id=p_owner_id;
  if twin.id is not null then select * into persona from public.social_personas where id=twin.active_social_persona_id; end if;
  insert into public.companion_controls(owner_id,companion_id,social_twin_visibility,social_autonomy_mode)
  values(p_owner_id,p_companion_id,coalesce(persona.profile_visibility,'PRIVATE'),coalesce(twin.autonomy_mode,'QUIET'))
  on conflict(owner_id,companion_id) do nothing;
  select * into result from public.companion_controls where owner_id=p_owner_id and companion_id=p_companion_id;
  return result;
end $$;

create or replace function companion_private.controls_payload(p_controls public.companion_controls)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'companionId',p_controls.companion_id,
    'schemaVersion',p_controls.schema_version,
    'revision',p_controls.revision,
    'settings',jsonb_build_object(
      'socialTwinVisibility',p_controls.social_twin_visibility,
      'socialAutonomyMode',p_controls.social_autonomy_mode,
      'memorySharingScope',p_controls.memory_sharing_scope,
      'notificationsEnabled',p_controls.notifications_enabled
    ),
    'supported',jsonb_build_object(
      'socialTwinVisibility',jsonb_build_array('PRIVATE','FRIENDS','PUBLIC'),
      'socialAutonomyMode',jsonb_build_array('QUIET','NORMAL','ACTIVE','CUSTOM'),
      'memorySharingScope',jsonb_build_array('PERMISSION_GATED_SOCIAL_ONLY'),
      'notificationsEnabled',true
    )
  )
$$;

create or replace function public.get_companion_controls(p_companion_id uuid)
returns table(payload jsonb)
language plpgsql security definer set search_path='' as $$
declare actor public.owners%rowtype; controls public.companion_controls%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  controls:=companion_private.ensure_companion_controls(actor.id,p_companion_id);
  return query select companion_private.controls_payload(controls);
exception when no_data_found then return;
end $$;

create or replace function public.update_companion_controls(
  p_companion_id uuid,
  p_if_match bigint,
  p_patch jsonb,
  p_idempotency_key_hash text,
  p_request_hash text
) returns table(payload jsonb)
language plpgsql security definer set search_path='' as $$
declare actor public.owners%rowtype; controls public.companion_controls%rowtype; existing companion_private.controls_idempotency%rowtype; result jsonb;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_if_match is null or p_if_match<1 or p_patch is null or jsonb_typeof(p_patch)<>'object'
    or p_patch='{}'::jsonb or p_idempotency_key_hash!~'^[a-f0-9]{64}$' or p_request_hash!~'^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='invalid Controls update request';
  end if;
  if exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('socialTwinVisibility','socialAutonomyMode','memorySharingScope','notificationsEnabled')) then
    raise exception using errcode='22023',message='unsupported Controls field';
  end if;
  if p_patch?'socialTwinVisibility' and p_patch->>'socialTwinVisibility' not in ('PRIVATE','FRIENDS','PUBLIC') then
    raise exception using errcode='22023',message='invalid Social Twin visibility';
  end if;
  if p_patch?'socialAutonomyMode' and p_patch->>'socialAutonomyMode' not in ('QUIET','NORMAL','ACTIVE','CUSTOM') then
    raise exception using errcode='22023',message='invalid social autonomy mode';
  end if;
  if p_patch?'memorySharingScope' and p_patch->>'memorySharingScope'<>'PERMISSION_GATED_SOCIAL_ONLY' then
    raise exception using errcode='22023',message='unsupported Memory sharing scope';
  end if;
  if p_patch?'notificationsEnabled' and jsonb_typeof(p_patch->'notificationsEnabled')<>'boolean' then
    raise exception using errcode='22023',message='invalid notification preference';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.controls_idempotency where owner_id=actor.id and idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.companion_id<>p_companion_id or existing.request_hash<>p_request_hash then
      raise exception using errcode='23505',message='Controls idempotency key reused with a different request';
    end if;
    return query select existing.result_payload; return;
  end if;

  controls:=companion_private.ensure_companion_controls(actor.id,p_companion_id);
  if controls.revision<>p_if_match then raise exception using errcode='23505',message='stale Controls revision'; end if;

  update public.companion_controls set
    social_twin_visibility=case when p_patch?'socialTwinVisibility' then p_patch->>'socialTwinVisibility' else controls.social_twin_visibility end,
    social_autonomy_mode=case when p_patch?'socialAutonomyMode' then p_patch->>'socialAutonomyMode' else controls.social_autonomy_mode end,
    memory_sharing_scope=case when p_patch?'memorySharingScope' then p_patch->>'memorySharingScope' else controls.memory_sharing_scope end,
    notifications_enabled=case when p_patch?'notificationsEnabled' then (p_patch->>'notificationsEnabled')::boolean else controls.notifications_enabled end,
    revision=controls.revision+1,
    updated_at=statement_timestamp()
  where owner_id=actor.id and companion_id=p_companion_id
  returning * into controls;

  if p_patch?'socialAutonomyMode' then
    update public.social_twins set autonomy_mode=controls.social_autonomy_mode,updated_at=statement_timestamp()
    where owner_id=actor.id and companion_id=p_companion_id;
  end if;

  result:=companion_private.controls_payload(controls);
  insert into companion_private.controls_idempotency(owner_id,companion_id,idempotency_key_hash,request_hash,result_revision,result_payload)
  values(actor.id,p_companion_id,p_idempotency_key_hash,p_request_hash,controls.revision,result);
  return query select result;
end $$;

create or replace function public.get_companion_profile(p_companion_id uuid)
returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype; companion public.companions%rowtype; twin public.social_twins%rowtype; persona public.social_personas%rowtype; controls public.companion_controls%rowtype; visibility text;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  select * into twin from public.social_twins where companion_id=p_companion_id and status<>'SUSPENDED';
  if not found then return; end if;
  select * into companion from public.companions where id=twin.companion_id;
  select * into persona from public.social_personas where id=twin.active_social_persona_id and companion_id=companion.id;
  if persona.id is null then return; end if;
  select * into controls from public.companion_controls where owner_id=companion.owner_id and companion_id=companion.id;
  visibility:=coalesce(controls.social_twin_visibility,persona.profile_visibility);
  if companion.owner_id<>actor.id and visibility<>'PUBLIC' then return; end if;
  return query select jsonb_build_object(
    'companionId',companion.id,'socialTwinId',twin.id,'socialPersonaId',persona.id,
    'handle',persona.handle,'displayName',persona.display_name,'profileVisibility',visibility,
    'identityVersion',persona.source_identity_version,'socialPersonaVersion',persona.version,
    'publicProfile',persona.public_document,
    'viewer',jsonb_build_object(
      'relationship',case when companion.owner_id=actor.id then 'OWNER_OF' else 'PUBLIC_VIEWER' end,
      'capabilities',jsonb_build_object('view',true,'startEncounter',false,'follow',false,'friend',false)
    ),
    'completeness','COMPLETE'
  );
end $$;

revoke all on function companion_private.ensure_companion_controls(uuid,uuid), companion_private.controls_payload(public.companion_controls) from public,anon,authenticated;
grant execute on function companion_private.ensure_companion_controls(uuid,uuid), companion_private.controls_payload(public.companion_controls) to service_role;
revoke all on function public.get_companion_controls(uuid), public.update_companion_controls(uuid,bigint,jsonb,text,text) from public,anon;
grant execute on function public.get_companion_controls(uuid), public.update_companion_controls(uuid,bigint,jsonb,text,text) to authenticated,service_role;

comment on table public.companion_controls is 'Revisioned Owner controls for one Companion; Memory sharing remains permission-gated and cannot be broadened by this resource.';
comment on function public.update_companion_controls(uuid,bigint,jsonb,text,text) is 'Exact-idempotent optimistic Controls update; stale revisions fail with a safe conflict.';

commit;
