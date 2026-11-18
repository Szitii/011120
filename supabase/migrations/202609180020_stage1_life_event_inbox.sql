begin;

create or replace function public.list_life_event_inbox(
  p_limit integer default 20,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
) returns table(item jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_limit<1 or p_limit>50 or ((p_before_created_at is null)<>(p_before_id is null)) then
    raise exception using errcode='22023',message='invalid Life Event Inbox page';
  end if;
  return query
  select jsonb_strip_nulls(jsonb_build_object(
    'id',inbox.id,
    'lifeEventId',inbox.life_event_id,
    'companionId',inbox.companion_id,
    'title',inbox.title,
    'createdAt',inbox.created_at,
    'readAt',inbox.read_at,
    'linkedObject',jsonb_build_object('type','LIFE_EVENT','id',inbox.life_event_id)
  ))
  from public.life_event_inbox inbox
  where inbox.owner_id=actor.id
    and (
      p_before_created_at is null
      or (inbox.created_at,inbox.id)<(p_before_created_at,p_before_id)
    )
  order by inbox.created_at desc,inbox.id desc
  limit p_limit;
end $$;

create or replace function public.ack_life_event_inbox_item(p_item_id uuid)
returns table(item jsonb)
language plpgsql security definer set search_path='' as $$
declare actor public.owners%rowtype; inbox public.life_event_inbox%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  update public.life_event_inbox
    set read_at=coalesce(read_at,statement_timestamp())
    where id=p_item_id and owner_id=actor.id
    returning * into inbox;
  if not found then return; end if;
  return query select jsonb_build_object(
    'id',inbox.id,
    'lifeEventId',inbox.life_event_id,
    'companionId',inbox.companion_id,
    'title',inbox.title,
    'createdAt',inbox.created_at,
    'readAt',inbox.read_at,
    'linkedObject',jsonb_build_object('type','LIFE_EVENT','id',inbox.life_event_id)
  );
end $$;

revoke all on function public.list_life_event_inbox(integer,timestamptz,uuid), public.ack_life_event_inbox_item(uuid) from public, anon;
grant execute on function public.list_life_event_inbox(integer,timestamptz,uuid), public.ack_life_event_inbox_item(uuid) to authenticated, service_role;

comment on function public.list_life_event_inbox(integer,timestamptz,uuid) is 'Owner-scoped durable Life Event Inbox read; the unique life_event_id constraint is the stable delivery dedupe identity.';
comment on function public.ack_life_event_inbox_item(uuid) is 'Idempotent Owner-scoped read acknowledgement; repeated calls preserve the first read_at timestamp.';

commit;
