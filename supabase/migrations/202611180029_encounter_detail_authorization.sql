-- Security fix: public Encounter detail capability derives from the immutable execution claim,
-- not the nullable legacy idempotency invitation reference.
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
            join companion_private.encounter_execution_claims execution on execution.id=terminal.execution_claim_id
            join public.encounter_invitations invitation on invitation.id=execution.invitation_id
            where terminal.encounter_id=feed.source_id
              and terminal.result_status in ('DELIVERED','REDACTED')
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

revoke all on function public.list_world_items(integer,timestamptz) from public,anon;
grant execute on function public.list_world_items(integer,timestamptz) to authenticated,service_role;

comment on function public.list_world_items(integer,timestamptz) is
  'Viewer-authorized public community projection. Encounter detail permission follows the immutable execution claim.';

commit;
