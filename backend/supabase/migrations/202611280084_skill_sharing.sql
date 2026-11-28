begin;

-- Shared skills (技能分享): an Owner offers a skill they wrote to everyone.
--
-- A shared skill is a row of companion_private.skills with an author. So it is switched on, takes
-- one of the five places and reaches the model exactly as an official skill does (skill_set,
-- skills_on, skill_texts). The official skills are the rows without an author.
--
--   PENDING   handed in, waiting for an operator. Only the author and the operators see it.
--   APPROVED  on the shelf: every Owner reads it, wording included, and can switch it on.
--   REJECTED  turned down; the author reads why (review_note).
--   REMOVED   taken off the shelf by an operator after it was approved: it is switched off for
--             every Companion that had it on, and the author reads why.
--
-- What is shared is a copy of one of the author's own skills (its title and text) with one line of
-- introduction, taken when it is handed in. Rewriting or deleting the own skill later changes
-- nothing on the shelf, so nothing on the shelf changes without an operator having read it. To
-- change a shared skill the author takes it back and hands in the new one.
--
-- A skill is an instruction to the model, and an approved one reaches other people's Companions.
-- Therefore: an operator reads every one before it is shown; a reader sees the whole wording
-- before switching it on; anyone can report one; and an operator takes it off for everyone at once.
-- Limits per Owner: 3 waiting, 20 waiting or on the shelf, 5 handed in a day, 20 reports a day.

alter table companion_private.skills
  add column author_id uuid references public.owners(id) on delete cascade,
  add column status text not null default 'APPROVED' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'REMOVED')),
  add column review_note text check (char_length(review_note) between 1 and 500),
  add column created_at timestamptz not null default now(),
  add column reviewed_at timestamptz,
  add constraint skills_official_approved check (author_id is not null or status = 'APPROVED');
create index skills_shelf on companion_private.skills(reviewed_at desc, id desc) where author_id is not null and status = 'APPROVED';
create index skills_by_author on companion_private.skills(author_id, created_at desc) where author_id is not null;

-- One report per Owner and skill. Handled ones are deleted (the log keeps what was decided).
create table companion_private.skill_reports (
  skill_id uuid not null references companion_private.skills(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  reason text not null check (reason in ('SPAM', 'HARASSMENT', 'HARMFUL', 'PRIVACY', 'OTHER')),
  details text not null default '' check (char_length(details) <= 1000),
  created_at timestamptz not null default now(),
  primary key (skill_id, owner_id)
);
create index skill_reports_by_owner on companion_private.skill_reports(owner_id, created_at);
alter table companion_private.skill_reports enable row level security;
alter table companion_private.skill_reports force row level security;
revoke all on companion_private.skill_reports from public, anon, authenticated;

-- ---------- for the Owner ----------

-- A skill on the shelf as a reader sees it. author: the person's community identity, or null when
-- they have none or their account is not in good standing. enabled: on for p_companion.
create function companion_private.shared_skill_json(s companion_private.skills, p_viewer uuid, p_companion uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', s.id, 'title', s.title, 'summary', s.summary, 'body', s.body,
    'author', (select companion_private.community_actor_json(a.id) from public.community_actors a join public.owners w on w.id = a.owner_id
      where a.owner_id = s.author_id and a.kind = 'HUMAN' and w.status = 'ACTIVE'),
    'usedBy', (select count(*) from companion_private.companion_skills k where k.skill_id = s.id),
    'enabled', p_companion is not null
      and exists(select 1 from companion_private.companion_skills k where k.companion_id = p_companion and k.skill_id = s.id),
    'mine', s.author_id = p_viewer,
    'sharedAt', s.reviewed_at)
$$;

-- A skill its author handed in, as the author sees it. note: what the operators wrote when they
-- turned it down or took it off.
create function companion_private.shared_skill_mine_json(s companion_private.skills)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', s.id, 'title', s.title, 'summary', s.summary, 'body', s.body, 'status', s.status, 'note', s.review_note,
    'usedBy', (select count(*) from companion_private.companion_skills k where k.skill_id = s.id),
    'createdAt', s.created_at, 'reviewedAt', s.reviewed_at)
$$;

-- How many skills are on for the Companion: official and shared ones still on offer, and its own.
create or replace function companion_private.skills_on(p_companion uuid)
returns integer language sql stable security definer set search_path='' as $$
  select (select count(*) from companion_private.companion_skills k join companion_private.skills s on s.id = k.skill_id
      where k.companion_id = p_companion and s.enabled and s.status = 'APPROVED')::integer
    + (select count(*) from companion_private.own_skills o where o.companion_id = p_companion and o.enabled)::integer
$$;

-- As in 0073, plus `shared`: the shared skills this Companion has on (so the Owner can read them
-- again and switch them off). The shelf itself is shared_skill_list.
create or replace function public.skill_list(p_companion uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  return jsonb_build_object('maxEnabled', 5,
    'official', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'summary', s.summary,
        'enabled', exists(select 1 from companion_private.companion_skills k where k.companion_id = c and k.skill_id = s.id))
        order by s.position, s.title, s.id)
      from companion_private.skills s where s.enabled and s.author_id is null), '[]'),
    'shared', coalesce((select jsonb_agg(companion_private.shared_skill_json(s, o, c) order by k.created_at, s.id)
      from companion_private.companion_skills k join companion_private.skills s on s.id = k.skill_id
      where k.companion_id = c and s.author_id is not null and s.enabled and s.status = 'APPROVED'), '[]'),
    'own', coalesce((select jsonb_agg(companion_private.own_skill_json(w) order by w.created_at, w.id)
      from companion_private.own_skills w where w.companion_id = c), '[]'));
end $$;

-- As in 0073: switches an official skill, or one on the shelf, on or off for the Companion.
create or replace function public.skill_set(p_companion uuid, p_skill uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.locked_companion(p_companion); -- first, so two requests cannot both count 4
  o uuid := companion_private.chat_owner();
begin
  if p_enabled is null then raise exception using errcode='22023', message='invalid skill'; end if;
  if not exists(select 1 from companion_private.skills where id = p_skill and enabled and status = 'APPROVED') then
    raise exception using errcode='P0001', message='skill not found';
  end if;
  if p_enabled then
    if not exists(select 1 from companion_private.companion_skills where companion_id = c and skill_id = p_skill) then
      if companion_private.skills_on(c) >= 5 then raise exception using errcode='55000', message='skill limit reached'; end if;
      insert into companion_private.companion_skills(companion_id, skill_id) values (c, p_skill);
    end if;
  else
    delete from companion_private.companion_skills where companion_id = c and skill_id = p_skill;
  end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'SKILL_SET', 'SKILL', p_skill);
  return public.skill_list(c);
end $$;

-- Server only. As in 0073, with the shared skills between the official ones and the Companion's
-- own (in the order they were switched on); 5 at most.
create or replace function public.skill_texts(p_companion uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('title', q.title, 'body', q.body) order by q.rank, q.place, q.id) from (
    select * from (
      select case when s.author_id is null then 0 else 1 end as rank,
          case when s.author_id is null then s.position::numeric else extract(epoch from k.created_at) end as place, s.id, s.title, s.body
        from companion_private.companion_skills k join companion_private.skills s on s.id = k.skill_id
        where k.companion_id = c and s.enabled and s.status = 'APPROVED'
      union all
      select 2, extract(epoch from w.created_at), w.id, w.title, w.body from companion_private.own_skills w
        where w.companion_id = c and w.enabled) x
    order by x.rank, x.place, x.id limit 5) q), '[]');
end $$;

-- The shelf, newest first, 20 a page: the approved skills of other people and the caller's own.
-- p_companion: say for each whether that Companion has it on. p_query: only those whose title or
-- introduction contains these words. Skills of someone on the other side of a block are left out.
create function public.shared_skill_list(p_companion uuid default null, p_query text default null,
  p_before_at timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); c uuid; v_query text := lower(btrim(coalesce(p_query, '')));
  items jsonb; n integer; last_item jsonb;
begin
  if (p_before_at is null) <> (p_before_id is null) or char_length(v_query) > 40 then
    raise exception using errcode='22023', message='invalid request';
  end if;
  if p_companion is not null then c := companion_private.owned_companion(p_companion); end if;
  select coalesce(jsonb_agg(companion_private.shared_skill_json(q.s, o, c) order by (q.s).reviewed_at desc, (q.s).id desc), '[]') into items
  from (select s from companion_private.skills s
    where s.author_id is not null and s.status = 'APPROVED' and s.enabled
      and (v_query = '' or position(v_query in lower(s.title || E'\n' || s.summary)) > 0)
      and (p_before_at is null or (s.reviewed_at, s.id) < (p_before_at, p_before_id))
      and not exists(select 1 from public.community_blocks b
        join public.community_actors ba on ba.id = b.actor_id join public.community_actors bt on bt.id = b.target_id
        where (ba.owner_id = o and bt.owner_id = s.author_id) or (ba.owner_id = s.author_id and bt.owner_id = o))
    order by s.reviewed_at desc, s.id desc limit 21) q;
  n := jsonb_array_length(items);
  if n > 20 then items := items - 20; end if;
  last_item := items->(jsonb_array_length(items) - 1);
  return jsonb_build_object('items', items,
    'nextCursor', case when n > 20 then to_char((last_item->>'sharedAt')::timestamptz at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || (last_item->>'id') end);
end $$;

-- What the caller handed in (the newest 100), and how much room is left.
create function public.shared_skill_mine()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(companion_private.shared_skill_mine_json(s) order by s.created_at desc, s.id desc)
      from (select * from companion_private.skills where author_id = o order by created_at desc, id desc limit 100) s), '[]'),
    'waiting', (select count(*) from companion_private.skills where author_id = o and status = 'PENDING'), 'maxWaiting', 3,
    'shared', (select count(*) from companion_private.skills where author_id = o and status in ('PENDING', 'APPROVED')), 'maxShared', 20,
    'todayLeft', greatest(5 - (select count(*) from public.audit_events where actor_id = o and action = 'SKILL_SHARE'
      and occurred_at > now() - interval '1 day'), 0)::integer);
end $$;

-- Server only (the texts are scanned first): hands in a copy of the Companion's own skill p_skill
-- with p_summary as its one line of introduction. The same title and text already waiting or on
-- the shelf: that one is returned and nothing new is made (a retry).
create function public.shared_skill_submit(p_companion uuid, p_skill uuid, p_summary text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
  v_summary text := btrim(p_summary); k companion_private.own_skills%rowtype; s companion_private.skills%rowtype;
begin
  if v_summary is null or v_summary !~ '\S' or char_length(v_summary) > 100 or v_summary ~ '[[:cntrl:]]' then
    raise exception using errcode='22023', message='invalid skill';
  end if;
  select * into k from companion_private.own_skills where id = p_skill and companion_id = c;
  if not found then raise exception using errcode='P0001', message='skill not found'; end if;
  -- One at a time per Owner, so the counts below hold.
  perform pg_advisory_xact_lock(hashtextextended('skill_share:' || o::text, 0));
  select * into s from companion_private.skills
    where author_id = o and title = k.title and body = k.body and status in ('PENDING', 'APPROVED') limit 1;
  if found then return companion_private.shared_skill_mine_json(s); end if;
  if (select count(*) from companion_private.skills where author_id = o and status = 'PENDING') >= 3
    or (select count(*) from companion_private.skills where author_id = o and status in ('PENDING', 'APPROVED')) >= 20
    or (select count(*) from public.audit_events where actor_id = o and action = 'SKILL_SHARE'
      and occurred_at > now() - interval '1 day') >= 5 then
    raise exception using errcode='55000', message='shared skill limit reached';
  end if;
  insert into companion_private.skills(title, summary, body, author_id, status) values (k.title, v_summary, k.body, o, 'PENDING') returning * into s;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'SKILL_SHARE', 'SKILL', s.id);
  return companion_private.shared_skill_mine_json(s);
end $$;

-- The author takes a skill back, whatever its state. The Companions that had it on lose it.
create function public.shared_skill_withdraw(p_skill uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  delete from companion_private.skills where id = p_skill and author_id = o;
  if not found then raise exception using errcode='P0001', message='skill not found'; end if;
  insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
    values (o, 'OWNER', o, 'SKILL_UNSHARE', 'SKILL', p_skill);
  return jsonb_build_object('deleted', true);
end $$;

-- Reports someone else's skill on the shelf to the operators. A second report of the same skill
-- by the same Owner changes nothing.
create function public.shared_skill_report(p_skill uuid, p_reason text, p_details text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); v_details text := btrim(coalesce(p_details, ''), E' \t\r\n');
begin
  if p_reason is null or p_reason not in ('SPAM', 'HARASSMENT', 'HARMFUL', 'PRIVACY', 'OTHER') or char_length(v_details) > 1000 then
    raise exception using errcode='22023', message='invalid report';
  end if;
  if not exists(select 1 from companion_private.skills where id = p_skill and author_id <> o and status = 'APPROVED') then
    raise exception using errcode='P0001', message='skill not found';
  end if;
  if (select count(*) from companion_private.skill_reports where owner_id = o and created_at > now() - interval '1 day') >= 20 then
    raise exception using errcode='55000', message='report limit reached';
  end if;
  insert into companion_private.skill_reports(skill_id, owner_id, reason, details) values (p_skill, o, p_reason, v_details)
    on conflict (skill_id, owner_id) do nothing;
  return jsonb_build_object('reported', true);
end $$;

-- As in 0074, with the shared skills told apart: a Companion's `officialSkills` are the platform's
-- only, `sharedSkills` the ones from the shelf it has on, and at the top `sharedSkills` is what the
-- Owner handed in.
create or replace function public.account_export()
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); v_wallet jsonb; v_from timestamptz;
begin
  -- One at a time per Owner, without waiting: requests sent together would each hold a connection
  -- while they queue. The count below is then safe from them too.
  if not pg_try_advisory_xact_lock(hashtextextended('account_export:' || o::text, 0)) then return null; end if;
  -- By actor: that is what the audit log is indexed on (the Owner is the actor of their own export).
  if (select count(*) from public.audit_events where actor_id = o and action = 'ACCOUNT_EXPORT'
      and occurred_at > now() - interval '1 hour') >= 5 then
    return null;
  end if;
  insert into public.audit_events(owner_id, actor_type, actor_id, action, target_type, target_id)
    values (o, 'OWNER', o, 'ACCOUNT_EXPORT', 'OWNER', o);
  v_wallet := public.wallet_get();
  -- The oldest moment the chats reach back to: the newest messages of all the Owner's chats, as
  -- many as fit the budget (a message counts as its characters plus 200 for what goes with it).
  select min(q.shown_at) into v_from from (
    select m.shown_at, row_number() over w as n, sum(coalesce(char_length(m.body), 0) + 200) over w as size
    from companion_private.chat_messages m join companion_private.chats ch on ch.id = m.chat_id
    where ch.owner_id = o and m.status = 'SENT' and m.shown_at <= now()
    window w as (order by m.shown_at desc, m.id desc)) q
  where q.n <= 20000 and q.size <= 3000000;
  return jsonb_build_object(
    'format', '011120-export/1',
    'exportedAt', now(),
    'owner', (select jsonb_build_object('id', w.id, 'createdAt', w.created_at,
        'profile', (select companion_private.community_actor_json(a.id) from public.community_actors a
          where a.owner_id = w.id and a.kind = 'HUMAN' limit 1))
      from public.owners w where w.id = o),
    'companions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'displayName', i.display_name, 'status', c.status, 'createdAt', c.created_at, 'avatar', c.avatar,
        'personaVersion', i.version, 'persona', i.identity_document,
        'chatSettings', (select companion_private.chat_settings_json(s) from companion_private.chat_settings s where s.companion_id = c.id),
        'diarySettings', (select companion_private.diary_settings_json(s) from companion_private.diary_settings s where s.companion_id = c.id),
        'anniversary', (select companion_private.anniversary_json(s) from companion_private.anniversaries s where s.companion_id = c.id),
        'connection', companion_private.connection_json(c.id),
        'agentKeys', coalesce((select jsonb_agg(companion_private.agent_key_json(k) order by k.created_at, k.id)
          from companion_private.agent_keys k where k.companion_id = c.id), '[]'),
        'memories', coalesce((select jsonb_agg(companion_private.memory_json(m) order by m.created_at, m.id)
          from companion_private.companion_memories m where m.companion_id = c.id), '[]'),
        'worldEntries', coalesce((select jsonb_agg(companion_private.world_json(e) order by e.created_at, e.id)
          from companion_private.world_entries e where e.companion_id = c.id), '[]'),
        'ownSkills', coalesce((select jsonb_agg(companion_private.own_skill_json(k) order by k.created_at, k.id)
          from companion_private.own_skills k where k.companion_id = c.id), '[]'),
        -- The official skills it has on, of those still on offer.
        'officialSkills', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'summary', k.summary) order by k.position, k.title, k.id)
          from companion_private.companion_skills x join companion_private.skills k on k.id = x.skill_id
          where x.companion_id = c.id and k.enabled and k.author_id is null), '[]'),
        -- The skills from the shelf it has on, of those still there.
        'sharedSkills', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'summary', k.summary) order by x.created_at, k.id)
          from companion_private.companion_skills x join companion_private.skills k on k.id = x.skill_id
          where x.companion_id = c.id and k.enabled and k.author_id is not null and k.status = 'APPROVED'), '[]'),
        'reminders', coalesce((select jsonb_agg(companion_private.chat_reminder_json(r) order by r.due_at, r.id)
          from companion_private.chat_reminders r where r.companion_id = c.id and r.status <> 'CANCELLED'), '[]'),
        'diary', coalesce((select jsonb_agg(companion_private.diary_entry_json(e) order by e.created_at, e.id)
          from companion_private.diary_entries e where e.companion_id = c.id and e.status = 'DONE'), '[]'),
        'chat', (select jsonb_build_object('id', ch.id, 'createdAt', ch.created_at) || companion_private.export_messages(ch.id, v_from)
          from companion_private.chats ch where ch.owner_id = o and ch.direct_companion_id = c.id)
      ) order by c.created_at, c.id)
      from public.companions c left join public.companion_identities i on i.id = c.current_identity_version_id
      where c.owner_id = o and c.status <> 'DELETED'), '[]'),
    -- What the Owner handed in for the shelf, whatever became of it.
    'sharedSkills', coalesce((select jsonb_agg(companion_private.shared_skill_mine_json(k) order by k.created_at, k.id)
      from companion_private.skills k where k.author_id = o), '[]'),
    'groupChats', coalesce((select jsonb_agg(jsonb_build_object('id', ch.id, 'title', ch.title, 'createdAt', ch.created_at,
        'members', companion_private.chat_members_json(ch.id)) || companion_private.export_messages(ch.id, v_from) order by ch.created_at, ch.id)
      from companion_private.chats ch where ch.owner_id = o and ch.direct_companion_id is null), '[]'),
    -- The identities the app lists for the Owner (community_identities): their own, and those of
    -- Companions that are neither deleted nor taken out of the community.
    'community', coalesce((select jsonb_agg(jsonb_build_object(
        'profile', companion_private.community_actor_json(a.id),
        'companionId', t.companion_id,
        -- Its posts and comments as the app reads them, less what is about other people or about the reader.
        'posts', coalesce((select jsonb_agg(companion_private.community_post_json(p.id, a.id)
            - '{author,mentions,commentsCount,likeCount,likedByMe,canDelete}'::text[] order by p.created_at, p.id)
          from public.community_posts p where p.actor_id = a.id and p.deleted_at is null), '[]'),
        'comments', coalesce((select jsonb_agg(companion_private.community_comment_json(m.id, a.id)
            - '{author,mentions,canDelete}'::text[] order by m.created_at, m.id)
          from public.community_comments m where m.actor_id = a.id and m.deleted_at is null), '[]'),
        -- Who it follows, as the app's own list shows them: not a profile that went private, was
        -- suspended, or is on the other side of a block.
        'following', coalesce((select jsonb_agg(jsonb_build_object('since', f.created_at) || companion_private.community_actor_json(f.target_id)
            order by f.created_at, f.target_id)
          from public.community_follows f where f.actor_id = a.id and companion_private.community_visible(f.target_id, a.id)), '[]'),
        'likedPostIds', coalesce((select jsonb_agg(l.post_id order by l.created_at, l.post_id)
          from public.community_likes l where l.actor_id = a.id), '[]')
      ) order by a.created_at, a.id)
      from public.community_actors a
      left join public.social_twins t on t.id = a.social_twin_id
      left join public.companions co on co.id = t.companion_id
      where a.owner_id = o and (a.kind = 'HUMAN' or (t.status <> 'SUSPENDED' and co.status not in ('DELETED', 'QUARANTINED')))), '[]'),
    'feedback', coalesce((select jsonb_agg(companion_private.feedback_json(f.id) order by f.created_at, f.id)
      from companion_private.feedback f where f.owner_id = o), '[]'),
    'wallet', v_wallet || jsonb_build_object(
      'entries', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', e.kind, 'purpose', e.purpose,
          'companionId', e.companion_id, 'freeCredits', e.delta_free, 'paidCredits', e.delta_paid) order by e.created_at, e.id)
        from (select x.* from companion_private.wallet_entries x where x.owner_id = o order by x.created_at desc, x.id desc limit 2000) e), '[]'),
      'entriesOmitted', greatest((select count(*) from companion_private.wallet_entries x where x.owner_id = o) - 2000, 0)));
end $$;

-- ---------- for the operators ----------

-- As in 0073, with `skills` the official ones only, and `shared`: what Owners handed in, the ones
-- waiting first (oldest first), then the reported ones, then the rest (newest first); 300 at most.
create or replace function companion_admin.kit()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'summary', t.summary, 'name', t.name,
        'description', t.description, 'personality', t.personality, 'example', t.example, 'position', t.position,
        'enabled', t.enabled, 'updatedAt', t.updated_at) order by t.position, t.title, t.id)
      from companion_private.persona_templates t), '[]'),
    'skills', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'summary', s.summary, 'body', s.body,
        'position', s.position, 'enabled', s.enabled, 'updatedAt', s.updated_at,
        'usedBy', (select count(*) from companion_private.companion_skills k where k.skill_id = s.id)) order by s.position, s.title, s.id)
      from companion_private.skills s where s.author_id is null), '[]'),
    'shared', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'summary', s.summary, 'body', s.body,
        'status', s.status, 'note', s.review_note, 'authorId', s.author_id,
        'author', (select companion_private.community_actor_json(a.id)->>'displayName' from public.community_actors a
          where a.owner_id = s.author_id and a.kind = 'HUMAN'),
        'createdAt', s.created_at, 'reviewedAt', s.reviewed_at,
        'usedBy', (select count(*) from companion_private.companion_skills k where k.skill_id = s.id),
        'reports', coalesce((select jsonb_agg(jsonb_build_object('reason', r.reason, 'details', r.details, 'at', r.created_at) order by r.created_at, r.owner_id)
          from companion_private.skill_reports r where r.skill_id = s.id), '[]')) order by s.place)
      from (select x.*, row_number() over (order by (x.status = 'PENDING') desc,
            exists(select 1 from companion_private.skill_reports r where r.skill_id = x.id) desc,
            case when x.status = 'PENDING' then x.created_at end asc, coalesce(x.reviewed_at, x.created_at) desc, x.id) as place
          from companion_private.skills x where x.author_id is not null) s
      where s.place <= 300), '[]'),
    'ownSkills', (select count(*) from companion_private.own_skills))
$$;

-- As in 0073, for the official skills only: what an Owner handed in is not rewritten by operators.
create or replace function companion_admin.skill_set(p_id uuid, p_title text, p_summary text, p_body text, p_position integer,
  p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid()); v_before jsonb;
begin
  select to_jsonb(s) - '{id,updated_at,author_id,status,review_note,created_at,reviewed_at}'::text[] into v_before
    from companion_private.skills s where s.id = p_id and s.author_id is null for update;
  if p_id is not null and v_before is null then raise exception using errcode='P0001', message='skill not found'; end if;
  -- Back on the shelf: the Companions that had it on have it on again, except those that filled
  -- their five places in the meantime (they would have six). For them it is off, like any other.
  if coalesce(p_enabled, true) and (v_before->>'enabled') = 'false' then
    delete from companion_private.companion_skills k where k.skill_id = p_id and companion_private.skills_on(k.companion_id) >= 5;
  end if;
  insert into companion_private.skills as s (id, title, summary, body, position, enabled)
    values (v_id, btrim(p_title), btrim(p_summary), btrim(p_body, E' \t\r\n'), coalesce(p_position, 0), coalesce(p_enabled, true))
    on conflict (id) do update set title = excluded.title, summary = excluded.summary, body = excluded.body,
      position = excluded.position, enabled = excluded.enabled, updated_at = now();
  perform companion_private.admin_note('SKILL_SET', 'SKILL', v_id::text, null, p_reason,
    jsonb_build_object('before', v_before, 'title', btrim(p_title), 'body', btrim(p_body, E' \t\r\n'), 'enabled', coalesce(p_enabled, true)));
end $$;

create or replace function companion_admin.skill_delete(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_before jsonb;
begin
  delete from companion_private.skills s where s.id = p_id and s.author_id is null
    returning to_jsonb(s) - '{id,updated_at,author_id,status,review_note,created_at,reviewed_at}'::text[] into v_before;
  if v_before is null then raise exception using errcode='P0001', message='skill not found'; end if;
  perform companion_private.admin_note('SKILL_DELETE', 'SKILL', p_id::text, null, p_reason, jsonb_build_object('before', v_before));
end $$;

-- An operator decides about a skill an Owner handed in. The reason is logged; for REJECT and
-- REMOVE it is also what the author reads.
--   APPROVE  one that waits, was turned down or was taken off: onto the shelf.
--   REJECT   one that waits: turned down.
--   REMOVE   one on the shelf: off, and off for every Companion that had it on.
--   KEEP     one on the shelf that was reported: it stays, the reports are closed.
create function companion_admin.shared_skill_review(p_id uuid, p_decision text, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare s companion_private.skills%rowtype; v_reason text := companion_private.admin_reason(p_reason); v_used bigint; v_reports bigint;
begin
  select * into s from companion_private.skills where id = p_id and author_id is not null for update;
  if not found then raise exception using errcode='P0001', message='skill not found'; end if;
  select count(*) into v_used from companion_private.companion_skills where skill_id = p_id;
  select count(*) into v_reports from companion_private.skill_reports where skill_id = p_id;
  if p_decision = 'APPROVE' and s.status <> 'APPROVED' then
    update companion_private.skills set status = 'APPROVED', review_note = null, reviewed_at = now() where id = p_id;
  elsif p_decision = 'REJECT' and s.status = 'PENDING' then
    update companion_private.skills set status = 'REJECTED', review_note = v_reason, reviewed_at = now() where id = p_id;
  elsif p_decision = 'REMOVE' and s.status = 'APPROVED' then
    update companion_private.skills set status = 'REMOVED', review_note = v_reason, reviewed_at = now() where id = p_id;
    delete from companion_private.companion_skills where skill_id = p_id;
    delete from companion_private.skill_reports where skill_id = p_id;
  elsif p_decision = 'KEEP' and s.status = 'APPROVED' and v_reports > 0 then
    delete from companion_private.skill_reports where skill_id = p_id;
  elsif p_decision in ('APPROVE', 'REJECT', 'REMOVE', 'KEEP') then
    raise exception using errcode='55000', message='skill is not in that state';
  else
    raise exception using errcode='22023', message='invalid decision';
  end if;
  perform companion_private.admin_note('SHARED_SKILL_' || p_decision, 'SKILL', p_id::text, s.author_id, p_reason,
    jsonb_build_object('title', s.title, 'summary', s.summary, 'body', s.body, 'before', s.status, 'usedBy', v_used, 'reports', v_reports));
end $$;

revoke all on function companion_private.shared_skill_json(companion_private.skills, uuid, uuid),
  companion_private.shared_skill_mine_json(companion_private.skills),
  public.shared_skill_list(uuid, text, timestamptz, uuid), public.shared_skill_mine(), public.shared_skill_submit(uuid, uuid, text),
  public.shared_skill_withdraw(uuid), public.shared_skill_report(uuid, text, text),
  companion_admin.shared_skill_review(uuid, text, text) from public, anon, authenticated;
grant execute on function public.shared_skill_list(uuid, text, timestamptz, uuid), public.shared_skill_mine(),
  public.shared_skill_withdraw(uuid), public.shared_skill_report(uuid, text, text) to authenticated;
grant execute on function public.shared_skill_submit(uuid, uuid, text) to companion_api;
grant execute on function companion_admin.shared_skill_review(uuid, text, text) to companion_admin;

insert into companion_private.schema_migrations(name) values ('202611280084_skill_sharing');

commit;
