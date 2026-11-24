begin;

-- Diary entries written in the background, without the app open.
--
--  * The Owner opts in per Companion: diary_settings.auto_write (default off). Off, nothing
--    changes: an entry is written only when the Owner opens the diary (0045).
--  * The API server asks diary_due every few minutes for Companions to write for, then writes each
--    one through the same diary_begin / diary_reserve / diary_finish as the app's request, as the
--    Owner. diary_begin's lock is still the only writer lock, so a background attempt and the app
--    opening the diary at the same moment write one entry.
--  * Due means: auto_write on, frequency not OFF, the interval since the last entry has passed,
--    no attempt is running, the last failed attempt is over an hour old (background retries wait
--    longer than the app's 10 minutes), and something happened since the last entry (an Owner
--    message or home-room action in the one-to-one chat, or the Companion's own post or comment).
--    Oldest first, a small batch per round.
--  * p_platform false (the server has no platform model): only Companions on the Owner's own key
--    or agent are due, so nothing fails over and over for want of a model.

alter table companion_private.diary_settings add column auto_write boolean not null default false;

create or replace function companion_private.diary_settings_json(s companion_private.diary_settings)
returns jsonb language sql immutable as $$
  select jsonb_build_object('frequency', s.frequency, 'autoWrite', s.auto_write, 'revision', s.revision)
$$;

drop function public.diary_update_settings(uuid, text, integer);
-- A stale revision (another device saved first) is a conflict. p_auto_write null keeps the
-- current value (an app that does not know the setting yet).
create function public.diary_update_settings(p_companion uuid, p_frequency text, p_auto_write boolean, p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s companion_private.diary_settings%rowtype; o uuid := companion_private.chat_owner();
begin
  if p_frequency is null or p_frequency not in ('OFF', 'RARE', 'DAILY', 'OFTEN') then
    raise exception using errcode='22023', message='invalid diary frequency';
  end if;
  s := companion_private.diary_settings_for(p_companion);
  update companion_private.diary_settings set frequency = p_frequency, auto_write = coalesce(p_auto_write, auto_write),
    revision = revision + 1
  where companion_id = s.companion_id and revision = p_revision returning * into s;
  if not found then raise exception using errcode='23505', message='diary settings revision conflict'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, s.companion_id, 'OWNER', o, 'DIARY_UPDATE_SETTINGS', 'COMPANION', s.companion_id);
  return companion_private.diary_settings_json(s);
end $$;

-- API server only: up to p_limit Companions whose diary should be written now, oldest first, with
-- the Owner's auth subject to write as. [{companionId, subject}]
create function public.diary_due(p_limit integer, p_platform boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('companionId', d.companion_id, 'subject', d.subject) order by d.last_done nulls first), '[]')
  from (
    select s.companion_id, o.auth_user_id as subject, e.last_done
    from companion_private.diary_settings s
    join public.companions c on c.id = s.companion_id and c.status = 'ACTIVE'
    join public.owners o on o.id = c.owner_id and o.status = 'ACTIVE'
    cross join lateral (select max(x.created_at) filter (where x.status in ('DONE', 'DELETED')) as last_done,
        max(x.created_at) filter (where x.status = 'FAILED') as last_failed,
        bool_or(x.status = 'WRITING' and x.created_at > now() - interval '3 minutes') as writing,
        greatest(max(x.covers_until) filter (where x.status in ('DONE', 'DELETED')), now() - interval '3 days') as since
      from companion_private.diary_entries x where x.companion_id = s.companion_id) e
    where s.auto_write and s.frequency <> 'OFF'
      and (p_platform or exists(select 1 from companion_private.companion_connections k where k.companion_id = s.companion_id))
      and coalesce(e.last_done + companion_private.diary_interval(s.frequency), '-infinity') <= now()
      and coalesce(e.last_failed + interval '1 hour', '-infinity') <= now()
      and not coalesce(e.writing, false)
      and (exists(select 1 from companion_private.chat_messages h join companion_private.chats ch on ch.id = h.chat_id
            where ch.direct_companion_id = s.companion_id and h.companion_id is null and h.status = 'SENT'
              and h.shown_at > coalesce(e.since, now() - interval '3 days'))
        or exists(select 1 from public.community_posts p join public.community_actors a on a.id = p.actor_id
            join public.social_twins t on t.id = a.social_twin_id
            where t.companion_id = s.companion_id and p.deleted_at is null and p.created_at > coalesce(e.since, now() - interval '3 days'))
        or exists(select 1 from public.community_comments m join public.community_actors a on a.id = m.actor_id
            join public.social_twins t on t.id = a.social_twin_id
            where t.companion_id = s.companion_id and m.deleted_at is null and m.created_at > coalesce(e.since, now() - interval '3 days')))
    order by e.last_done nulls first
    limit greatest(0, least(p_limit, 100))) d
$$;

revoke all on function public.diary_update_settings(uuid, text, boolean, integer), public.diary_due(integer, boolean)
  from public, anon, authenticated;
grant execute on function public.diary_update_settings(uuid, text, boolean, integer) to authenticated;
grant execute on function public.diary_due(integer, boolean) to companion_api;

commit;
