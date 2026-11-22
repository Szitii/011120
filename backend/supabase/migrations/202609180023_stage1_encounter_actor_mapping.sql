begin;

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
  with candidates as (
    select
      le.id,
      'LIFE_EVENT'::text kind,
      le.title,
      le.created_at,
      le.companion_id,
      le.id linked_id,
      'AVAILABLE'::text status
    from public.life_events le
    where le.owner_id=actor.id
      and (p_before_created_at is null or le.created_at<p_before_created_at)

    union all

    select
      c.encounter_id,
      'ENCOUNTER'::text,
      case when ei.purpose is null then 'Encounter' else left(ei.purpose,200) end,
      coalesce(ei.used_at,ei.claimed_at,ei.created_at),
      case
        when actor.id=ei.initiator_owner_id then responder_twin.companion_id
        else initiator_twin.companion_id
      end,
      c.encounter_id,
      c.result_status
    from companion_private.encounter_idempotency c
    join public.encounter_invitations ei on ei.id=c.invitation_id
    join public.social_twins initiator_twin on initiator_twin.id=ei.initiator_twin_id
    join public.social_twins responder_twin on responder_twin.id=ei.responder_twin_id
    where actor.id in(ei.initiator_owner_id,ei.responder_owner_id)
      and (p_before_created_at is null or coalesce(ei.used_at,ei.claimed_at,ei.created_at)<p_before_created_at)
  )
  select jsonb_build_object(
    'id',id,
    'kind',kind,
    'title',title,
    'createdAt',created_at,
    'actor',jsonb_strip_nulls(jsonb_build_object('companionId',companion_id)),
    'linkedObject',jsonb_build_object('type',kind,'id',linked_id),
    'status',status,
    'completeness','COMPLETE',
    'capabilities',jsonb_build_object('open',true)
  )
  from candidates
  order by created_at desc,id desc
  limit p_limit;
end $$;

revoke all on function public.list_world_items(integer,timestamptz) from public, anon;
grant execute on function public.list_world_items(integer,timestamptz) to authenticated, service_role;

comment on function public.list_world_items(integer,timestamptz)
is 'Lists Owner-authorized World items and, for Encounter items, exposes only the authorized other participant Companion id needed for deterministic profile navigation.';

commit;
