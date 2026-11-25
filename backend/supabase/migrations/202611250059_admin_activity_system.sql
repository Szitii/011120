-- Two read-only pages of the admin console: 运营数据 (how much the App is used, per day) and 系统
-- (how full the database is). Counts only: no message text, no names, no e-mail.
begin;

-- One month (UTC), per day: new Owners, Owners who chatted, messages both ways, voice, posts,
-- comments, credits. Messages of a deleted chat are gone with it, so they are not counted.
create function companion_admin.activity(p_month date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  t0 timestamptz := v_from::timestamp at time zone 'UTC';
  t1 timestamptz := (v_to + 1)::timestamp at time zone 'UTC';
  v_last date := least(v_to, (now() at time zone 'UTC')::date);
  v_days jsonb; v_chatters bigint;
begin
  select count(distinct c.owner_id) into v_chatters
    from companion_private.chat_messages m join companion_private.chats c on c.id = m.chat_id
    where m.companion_id is null and m.created_at >= t0 and m.created_at < t1;

  with
  owners as (select (created_at at time zone 'UTC')::date as day, count(*) as n from public.owners
    where created_at >= t0 and created_at < t1 group by 1),
  msg as (select (m.created_at at time zone 'UTC')::date as day,
      count(distinct c.owner_id) filter (where m.companion_id is null) as chatters,
      count(*) filter (where m.companion_id is null) as sent,
      count(*) filter (where m.companion_id is not null and m.status = 'SENT') as replies,
      count(*) filter (where m.status = 'FAILED') as failed
    from companion_private.chat_messages m join companion_private.chats c on c.id = m.chat_id
    where m.created_at >= t0 and m.created_at < t1 group by 1),
  voice as (select (created_at at time zone 'UTC')::date as day, count(*) filter (where kind = 'HEAR') as hear,
      count(*) filter (where kind = 'SPEAK') as speak
    from companion_private.voice_usage where created_at >= t0 and created_at < t1 group by 1),
  posts as (select (p.created_at at time zone 'UTC')::date as day, count(*) filter (where a.kind = 'HUMAN') as human,
      count(*) filter (where a.kind = 'AI') as ai
    from public.community_posts p join public.community_actors a on a.id = p.actor_id
    where p.created_at >= t0 and p.created_at < t1 group by 1),
  comments as (select (created_at at time zone 'UTC')::date as day, count(*) as n from public.community_comments
    where created_at >= t0 and created_at < t1 group by 1),
  credits as (select (created_at at time zone 'UTC')::date as day,
      -coalesce(sum(delta_free + delta_paid) filter (where kind in ('HOLD', 'RELEASE')), 0) as spent,
      coalesce(sum(delta_paid) filter (where kind = 'PURCHASE'), 0) as bought
    from companion_private.wallet_entries where created_at >= t0 and created_at < t1 group by 1)
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day,
      'newOwners', coalesce(o.n, 0), 'chatters', coalesce(m.chatters, 0), 'ownerMessages', coalesce(m.sent, 0),
      'replies', coalesce(m.replies, 0), 'failed', coalesce(m.failed, 0), 'voiceIn', coalesce(v.hear, 0), 'voiceOut', coalesce(v.speak, 0),
      'posts', coalesce(p.human, 0), 'aiPosts', coalesce(p.ai, 0), 'comments', coalesce(cm.n, 0),
      'creditsSpent', coalesce(cr.spent, 0), 'creditsBought', coalesce(cr.bought, 0)) order by d.day), '[]')
    into v_days
  from (select generate_series(v_from, v_last, interval '1 day')::date as day) d
  left join owners o using (day) left join msg m using (day) left join voice v using (day)
  left join posts p using (day) left join comments cm using (day) left join credits cr using (day);

  return jsonb_build_object('month', to_char(v_from, 'YYYY-MM'), 'from', v_from, 'to', v_to,
    'owners', (select count(*) from public.owners where status <> 'DELETED'),
    'companions', (select count(*) from public.companions where status <> 'DELETED'),
    'chatters', v_chatters, 'days', v_days);
end $$;

-- How full the database is: its size, connections, the biggest tables.
create function companion_admin.system()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'databaseBytes', pg_database_size(current_database()),
    'connections', (select count(*) from pg_catalog.pg_stat_activity where datname = current_database()),
    'maxConnections', current_setting('max_connections')::integer,
    'startedAt', pg_postmaster_start_time(),
    'version', current_setting('server_version'),
    'tables', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'bytes', t.bytes, 'rows', t.rows) order by t.bytes desc)
      from (select n.nspname || '.' || c.relname as name, pg_total_relation_size(c.oid) as bytes,
          case when c.reltuples < 0 then null else c.reltuples::bigint end as rows
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname in ('public', 'companion_private', 'auth', 'storage')
        order by 2 desc limit 12) t), '[]'))
$$;

revoke all on function companion_admin.activity(date), companion_admin.system() from public, anon, authenticated;
grant execute on function companion_admin.activity(date), companion_admin.system() to companion_admin;

commit;
