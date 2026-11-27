begin;

-- 相遇 (Encounter) is gone. Running one was removed from the server on 2026-11-23 and it never ran in
-- production; what was left was a read route for an Encounter's detail and the database objects
-- behind it. This drops those objects and the pieces that only existed for it: publication budgets
-- and reservations (an Encounter reserved its feed slot before it ran) and provider call
-- reconciliations (settling an Encounter that started but never finished).
--
-- Kept on purpose: life events and their inbox (the inbox also carries Companion draft notices),
-- the compute ledger (chat uses it), and the word ENCOUNTER in a few allowed-value lists and labels
-- (they cost nothing and removing them would rewrite tables).
--
-- Refuses to run if any of these tables holds a row, so no data is lost by surprise.

do $$
begin
  if exists (select 1 from public.encounter_invitations)
    or exists (select 1 from public.encounter_artifacts)
    or exists (select 1 from companion_private.encounter_safety_events)
    or exists (select 1 from companion_private.encounter_idempotency)
    or exists (select 1 from companion_private.encounter_execution_claims)
    or exists (select 1 from companion_private.encounter_invitation_idempotency)
    or exists (select 1 from companion_private.encounter_invitation_decisions)
    or exists (select 1 from companion_private.encounter_context_snapshots)
    or exists (select 1 from companion_private.provider_call_reconciliations)
    or exists (select 1 from public.publication_reservations)
    or exists (select 1 from public.social_feed_items where source_type = 'ENCOUNTER')
  then
    raise exception 'Encounter tables are not empty; stop and look before dropping them';
  end if;
end $$;

-- The two reads that still looked at Encounter tables.
CREATE OR REPLACE FUNCTION public.list_world_items(p_limit integer DEFAULT 20, p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(item jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'openDetail',false,
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
end $function$;

CREATE OR REPLACE FUNCTION public.list_life_continuity(p_active_subject_kind text DEFAULT 'OWNER'::text, p_active_subject_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 30, p_before_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(item jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  from life_rows
  where p_before_occurred_at is null
     or (occurred_at,id)<(p_before_occurred_at,p_before_id)
  order by occurred_at desc,id desc
  limit p_limit;
end $function$;

-- A chat compute start no longer checks for an Encounter execution claim.
drop trigger compute_start_requires_encounter_claim on public.compute_ledger_entries;
drop function companion_private.require_claim_before_encounter_start();

drop function public.get_encounter_detail(uuid);
drop function public.issue_encounter_invitation(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text,text);
drop function public.list_encounter_invitations(integer,timestamptz,uuid);
drop function public.approve_encounter_invitation(uuid,text,text);
drop function public.reject_encounter_invitation(uuid,text,text);
drop function companion_private.assemble_encounter_context(uuid,uuid,text,text,text,integer);
drop function companion_private.claim_encounter_execution(uuid,text,text,uuid,uuid,uuid,uuid);
drop function companion_private.decide_encounter_invitation(uuid,text,text,text);
drop function companion_private.get_encounter_preparation(uuid,uuid);
drop function companion_private.get_encounter_terminal_result(uuid,text,text);
drop function companion_private.list_stale_started_encounter_candidates(timestamptz,timestamptz,uuid,integer);
drop function companion_private.persist_delivered_encounter(uuid,text,text,uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz);
drop function companion_private.persist_encounter_non_delivery(uuid,text,text,uuid,uuid,text,text,uuid,uuid,uuid,timestamptz);
drop function companion_private.reconcile_stale_started_encounter(uuid,uuid,text,text,text);
drop function companion_private.record_encounter_safety_event(uuid,uuid,uuid,uuid,text,text,text[],text,text,integer,text,uuid);
drop function companion_private.recover_stale_unstarted_encounter(uuid,uuid);
drop function companion_private.reserve_publication(uuid,uuid,uuid,text,text);
drop function companion_private.complete_publication_reservation(uuid,uuid,text,text);

-- One statement, so the foreign keys between these tables do not decide the order. No cascade:
-- anything else still pointing at them stops the migration.
drop table
  companion_private.provider_call_reconciliations,
  public.encounter_artifacts,
  companion_private.encounter_context_snapshots,
  companion_private.encounter_idempotency,
  companion_private.encounter_execution_claims,
  companion_private.encounter_invitation_decisions,
  companion_private.encounter_invitation_idempotency,
  companion_private.encounter_safety_events,
  public.encounter_invitations,
  public.publication_reservations,
  public.publication_budgets;

-- Trigger functions whose tables are gone.
drop function companion_private.bind_terminal_encounter_to_claim();
drop function companion_private.allow_invitation_claim_then_consume();
drop function companion_private.allow_invitation_consume_only();
drop function companion_private.complete_legacy_invitation_seed();
drop function companion_private.allow_publication_terminal_transition();

insert into companion_private.schema_migrations(name) values ('202611270079_remove_encounter');

commit;
