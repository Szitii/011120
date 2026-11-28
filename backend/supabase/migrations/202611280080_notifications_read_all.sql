begin;

-- "全部已读" (asked for by the app on 2026-11-26): every notice up to a moment, in one call.
--
--   PUT /v0/community/notifications/read?actorKind=&actorId=   { before? }   one identity's community notices
--   PUT /v0/life-event-inbox/read                              { before? }   the Owner's own notices
--
-- `before` is the createdAt of the newest notice the app is showing, so one that arrived while
-- the Owner was looking at the list stays unread. Without it, everything up to now is read.
-- A createdAt cut to milliseconds (a JavaScript Date) still covers its own notice.
--
-- Both answer {"read": n}, the number that turned read; calling again answers 0. For the
-- community, only notices the list shows are marked (the rule of the list and of the badge,
-- community_notice_shown), so the badge drops by n and a hidden one cannot be read unseen.

create function public.community_read_notifications(p_kind text, p_id uuid, p_before timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; n integer;
begin
  a := companion_private.community_actor(p_kind, p_id);
  update public.community_notifications nt set read_at = now()
    where nt.recipient_id = a.id and nt.read_at is null
      and date_trunc('milliseconds', nt.created_at) <= least(coalesce(p_before, now()), now())
      and companion_private.community_notice_shown(nt);
  get diagnostics n = row_count;
  return jsonb_build_object('read', n);
end $$;

create function public.read_life_event_inbox(p_before timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); n integer;
begin
  update public.life_event_inbox set read_at = now()
    where owner_id = o and read_at is null
      and date_trunc('milliseconds', created_at) <= least(coalesce(p_before, now()), now());
  get diagnostics n = row_count;
  return jsonb_build_object('read', n);
end $$;

revoke all on function public.community_read_notifications(text, uuid, timestamptz), public.read_life_event_inbox(timestamptz)
  from public, anon, authenticated;
grant execute on function public.community_read_notifications(text, uuid, timestamptz), public.read_life_event_inbox(timestamptz)
  to authenticated;

insert into companion_private.schema_migrations(name) values ('202611280080_notifications_read_all');

commit;
