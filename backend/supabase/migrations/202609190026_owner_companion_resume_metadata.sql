begin;

create or replace function public.list_owner_companions()
returns table(item jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype;
begin
  select * into actor
  from public.owners
  where auth_user_id=(select auth.uid()) and status='ACTIVE';

  if not found then
    raise exception using errcode='42501',message='active Owner authentication is required';
  end if;

  return query
  select jsonb_strip_nulls(jsonb_build_object(
    'companionId',c.id,
    'displayName',ci.display_name,
    'identityId',ci.id,
    'identityVersion',ci.version,
    'approvedFields',(
      select coalesce(jsonb_agg(k order by k),'[]'::jsonb)
      from jsonb_object_keys(ci.identity_document) k
    ),
    'status',c.status,
    'socialReady',(st.id is not null and st.status<>'SUSPENDED' and sp.id is not null),
    'socialTwinId',st.id,
    'handle',sp.handle
  ))
  from public.companions c
  join public.companion_identities ci
    on ci.id=c.current_identity_version_id
   and ci.companion_id=c.id
   and ci.owner_id=actor.id
  left join public.social_twins st
    on st.companion_id=c.id
   and st.owner_id=actor.id
  left join public.social_personas sp
    on sp.id=st.active_social_persona_id
   and sp.companion_id=c.id
  where c.owner_id=actor.id
    and c.status not in ('DELETED','QUARANTINED')
  order by c.created_at asc,c.id asc;
end $$;

comment on function public.list_owner_companions() is
  'Owner-scoped Companion roster with current approved identity metadata sufficient to resume Social Persona activation without exposing private field values.';

commit;
