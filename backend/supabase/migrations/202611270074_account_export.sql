begin;

-- An Owner takes a copy of everything of theirs (数据导出): GET /v0/export.
--
-- One JSON document, built from the same pieces the app reads (the *_json functions), so it says
-- what the app says:
--   owner       who they are in the community
--   companions  each Companion that is not deleted: its persona, settings, memories, world book,
--               skills, reminders, diary, how it is connected (never the key), its agent keys
--               (never the token), and the one-to-one chat
--   groupChats  the group chats, with their messages
--   community   for the Owner and each Companion with a community identity the app shows: profile,
--               posts, comments, who it follows, what it liked
--   feedback    the feedback threads
--   wallet      the credits and the entries
--
-- What is not in it: other people's content (only the Owner's own posts and comments; of the
-- identities it follows, only those the app would still show), audio (a voice message is its
-- transcript, marked as voice), picture files (a post names its pictures by path; the app can fetch
-- them), keys and tokens, what operators wrote (the note on a wallet adjustment), and what was
-- deleted or cancelled.
--
-- The document is large to build and to send, so:
--   - an Owner gets at most 5 an hour, one at a time, each one in the audit log. Past that, or
--     while another one of theirs is being built, the answer is null and nothing else happens;
--   - the chats together bring the Owner's newest messages up to a budget (20,000 messages, and
--     about 3 million characters); each chat says in `omitted` how many older ones it leaves out
--     (they can still be read in the chat itself, page by page);
--   - the wallet brings its newest 2,000 entries, and `entriesOmitted` the number of older ones.
-- The API server passes the document on as text, without taking it apart.

create function public.account_export()
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
          where x.companion_id = c.id and k.enabled), '[]'),
        'reminders', coalesce((select jsonb_agg(companion_private.chat_reminder_json(r) order by r.due_at, r.id)
          from companion_private.chat_reminders r where r.companion_id = c.id and r.status <> 'CANCELLED'), '[]'),
        'diary', coalesce((select jsonb_agg(companion_private.diary_entry_json(e) order by e.created_at, e.id)
          from companion_private.diary_entries e where e.companion_id = c.id and e.status = 'DONE'), '[]'),
        'chat', (select jsonb_build_object('id', ch.id, 'createdAt', ch.created_at) || companion_private.export_messages(ch.id, v_from)
          from companion_private.chats ch where ch.owner_id = o and ch.direct_companion_id = c.id)
      ) order by c.created_at, c.id)
      from public.companions c left join public.companion_identities i on i.id = c.current_identity_version_id
      where c.owner_id = o and c.status <> 'DELETED'), '[]'),
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

-- {"messages", "omitted"}: a chat's messages from p_from on (all of them when it is null) as the
-- Owner saw them, oldest first: what was said (the Owner's when companionId is null), home-room
-- actions, whether it was a voice message (the body is then what was said aloud), and whether the
-- Companion wrote it without being written to. `omitted`: how many older ones there are besides.
create function companion_private.export_messages(p_chat uuid, p_from timestamptz)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'messages', coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'at', m.shown_at, 'companionId', m.companion_id, 'body', m.body,
        'action', m.action, 'voice', exists(select 1 from companion_private.chat_audio a where a.message_id = m.id),
        'reach', case m.reply_to when 'SELF' then 'GREETING' when 'REMINDER' then 'REMINDER' end) order by m.shown_at, m.id)
      filter (where p_from is null or m.shown_at >= p_from), '[]'),
    'omitted', count(*) filter (where m.shown_at < p_from))
  from companion_private.chat_messages m where m.chat_id = p_chat and m.status = 'SENT' and m.shown_at <= now()
$$;

revoke all on function public.account_export(), companion_private.export_messages(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.account_export() to authenticated;

insert into companion_private.schema_migrations(name) values ('202611270074_account_export');

commit;
