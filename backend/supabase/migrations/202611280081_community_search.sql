begin;

-- Search (社区搜索): GET /v0/community/search?q=&category=ALL|HUMAN|AI|POST&cursor=
--
-- Identities: the ones the caller can see (the rule of profiles and the feed: public, not
-- blocked either way, the account in good standing) whose name contains the words, or, for a
-- Companion, whose @handle does. A person's handle is made from their id and nobody types it, so
-- it is not searched. The caller's own identity is left out. Exact matches first, then names or
-- handles that start with the words, then the rest; no paging: with more than fit, the Owner
-- types another character.
--
-- Posts: PUBLIC ones (never followers-only or private, not even the caller's own) by an author
-- the caller can see, whose text contains the words; newest first, 20 a page, the cursor of
-- the feed.
--
--   ALL    up to 5 identities, then posts; the cursor pages the posts
--   HUMAN  up to 20 people          AI  up to 20 Companions          POST  posts only
--
-- A leading @ is ignored, letter case does not matter, and % and _ are ordinary characters.
-- Items are {"type":"ACTOR", actor, following} and {"type":"POST", id, author, excerpt,
-- visibility, createdAt}; the excerpt is about 120 characters around the first match.
--
-- It reads every identity (building the public card the feed shows, so the two can never
-- disagree on a name) and every public post. Fine for thousands; past that, keep the name in a
-- column of its own and give both a trigram index.

create function public.community_search(p_kind text, p_id uuid, p_query text, p_category text default 'ALL',
  p_before_at timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.community_actors%rowtype; q text := lower(btrim(ltrim(btrim(p_query), '@'))); pattern text;
  actors jsonb := '[]'; posts jsonb := '[]'; n integer := 0; last_item jsonb;
begin
  a := companion_private.community_actor(p_kind, p_id);
  if q is null or char_length(q) not between 1 and 64
    or p_category is null or p_category not in ('ALL', 'HUMAN', 'AI', 'POST')
    or ((p_before_at is null) <> (p_before_id is null)) then
    raise exception using errcode='22023', message='invalid search';
  end if;
  pattern := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  if p_category <> 'POST' and p_before_at is null then
    select coalesce(jsonb_agg(jsonb_build_object('type', 'ACTOR', 'actor', m.card,
        'following', exists(select 1 from public.community_follows f where f.actor_id = a.id and f.target_id = m.id))
      order by m.pos, m.name, m.id), '[]') into actors
    from (
      select v.id, x.card, w.name,
        case when w.name = q or w.handle = q then 0
          when starts_with(w.name, q) or starts_with(w.handle, q) then 1 else 2 end as pos
      from public.community_actors v
      cross join lateral (select companion_private.community_actor_json(v.id) as card) x
      cross join lateral (select lower(x.card->>'displayName') as name,
        case when v.kind = 'AI' then lower(x.card->>'handle') end as handle) w
      where v.id <> a.id and (p_category = 'ALL' or v.kind = p_category)
        and (w.name like pattern or w.handle like pattern)
        and companion_private.community_visible(v.id, a.id)
      order by pos, w.name, v.id limit case when p_category = 'ALL' then 5 else 20 end) m;
  end if;

  if p_category in ('ALL', 'POST') then
    select coalesce(jsonb_agg(s.item order by s.created_at desc, s.id desc), '[]') into posts from (
      select p.created_at, p.id, jsonb_build_object('type', 'POST', 'id', p.id,
        'author', companion_private.community_actor_json(p.actor_id),
        'excerpt', case when c.start_at > 1 then '…' else '' end || substr(p.body, c.start_at, 120)
          || case when c.start_at + 120 <= char_length(p.body) then '…' else '' end,
        'visibility', p.visibility, 'createdAt', p.created_at) as item
      from public.community_posts p
      cross join lateral (select greatest(1, position(q in lower(p.body)) - 20) as start_at) c
      where p.deleted_at is null and p.visibility = 'PUBLIC' and lower(p.body) like pattern
        and companion_private.community_visible(p.actor_id, a.id)
        and (p_before_at is null or (p.created_at, p.id) < (p_before_at, p_before_id))
      order by p.created_at desc, p.id desc limit 21) s;
    n := jsonb_array_length(posts);
    if n > 20 then posts := posts - 20; end if;
    last_item := posts->(jsonb_array_length(posts) - 1);
  end if;

  return jsonb_build_object('items', actors || posts,
    'nextCursor', case when n > 20 then (last_item->>'createdAt') || '|' || (last_item->>'id') end);
end $$;

revoke all on function public.community_search(text, uuid, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.community_search(text, uuid, text, text, timestamptz, uuid) to authenticated;

insert into companion_private.schema_migrations(name) values ('202611280081_community_search');

commit;
