begin;

-- Tools (工具): while it answers its Owner, a Companion may look things up and do things through
-- tool servers the Owner connected, such as ordering food (外卖).
--
-- A tool server speaks MCP (Model Context Protocol) over HTTPS. Which servers there are is the
-- operators' list (tool_servers, the 目录): for each one its address, how an Owner gets a token for
-- it, and the tools a Companion may use there, by name, in two lists:
--   read_tools     looked up freely (menus, prices, the Owner's own addresses and orders);
--   confirm_tools  done only after the Owner said yes to that very call (create an order, cancel one).
-- A tool on neither list is not offered, so a tool the server adds later does nothing here until an
-- operator has read what it does.
--
-- An Owner connects a server to one Companion with their own token for it (companion_tools). The
-- token is sealed by the API server, bound to the Companion, like a model key (0048); the Owner sees
-- its last 4 characters. With it the API server asks the tool server which tools it has and keeps
-- that list.
--
-- A turn that answers the Owner in a one-to-one chat, with the operators' switch COMPANION_TOOLS
-- on, is offered the tools (chat_claim: canUseTools). The model may call them a few times before it
-- writes its reply. Every call is noted (tool_calls: who, which tool, whether it worked; never what
-- was sent or what came back), and chat_quota.daily_tool_calls caps them per Owner and UTC day.
--
-- A confirm tool is not called by the model's say-so. The API server keeps the call as a request
-- on the reply (tool_requests), the app shows it as a card, and it is made when the Owner confirms
-- within 15 minutes: then the result is kept with the request and the Companion gets a turn to
-- tell the Owner. One request per reply.
--
-- What a tool returns is data from outside. It reaches the model marked as such, and it is kept
-- only for a confirmed request (4000 characters at most).

alter table companion_private.feature_switches drop constraint feature_switches_key_check;
alter table companion_private.feature_switches add constraint feature_switches_key_check
  check (key in ('GROUP_CHAT_CREATE', 'GROUP_CHAT_SEND', 'COMMUNITY_NEW_NOTICES', 'COMPANION_ACTIONS', 'VOICE_INPUT', 'COMPANION_REACH',
    'COMPANION_WEB', 'COMPANION_TOOLS'));
insert into companion_private.feature_switches(key, enabled) values ('COMPANION_TOOLS', false);

alter table companion_private.chat_quota
  add column daily_tool_calls integer not null default 100 check (daily_tool_calls between 0 and 100000);

create table companion_private.tool_servers (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  title text not null check (char_length(title) between 1 and 20 and title ~ '\S'),
  summary text not null check (char_length(summary) between 1 and 100 and summary ~ '\S'),
  url text not null check (char_length(url) <= 300 and url ~ '^https://[^\s?#@]+$'),
  token_help text not null check (char_length(token_help) between 1 and 500 and token_help ~ '\S'),
  read_tools text[] not null default '{}',
  confirm_tools text[] not null default '{}',
  enabled boolean not null default true,
  position integer not null default 0,
  updated_at timestamptz not null default now(),
  check (cardinality(read_tools) + cardinality(confirm_tools) <= 60),
  check (not read_tools && confirm_tools)
);

-- tools: what the server listed when the Owner connected it, [{name, description, inputSchema}].
create table companion_private.companion_tools (
  companion_id uuid not null references public.companions(id) on delete cascade,
  server_id uuid not null references companion_private.tool_servers(id) on delete cascade,
  secret text not null check (secret ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'),
  secret_hint text not null check (char_length(secret_hint) <= 4),
  tools jsonb not null check (jsonb_typeof(tools) = 'array' and pg_column_size(tools) <= 200000),
  listed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (companion_id, server_id)
);

-- A call a Companion wants made and its Owner has to confirm. message_id: the reply it came with.
-- RUNNING: the Owner confirmed and the API server is making the call.
create table companion_private.tool_requests (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references companion_private.chat_messages(id) on delete cascade,
  companion_id uuid not null references public.companions(id) on delete cascade,
  server_id uuid not null references companion_private.tool_servers(id) on delete cascade,
  tool text not null check (char_length(tool) between 1 and 100),
  arguments jsonb not null check (jsonb_typeof(arguments) = 'object' and pg_column_size(arguments) <= 20000),
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DECLINED')),
  result text check (char_length(result) <= 4000),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table companion_private.tool_calls (
  id bigint generated always as identity primary key,
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null references public.companions(id) on delete cascade,
  server_key text not null,
  tool text not null check (char_length(tool) between 1 and 100),
  ok boolean not null,
  created_at timestamptz not null default now()
);
create index tool_calls_owner_day on companion_private.tool_calls(owner_id, created_at);

alter table companion_private.tool_servers enable row level security;
alter table companion_private.tool_servers force row level security;
alter table companion_private.companion_tools enable row level security;
alter table companion_private.companion_tools force row level security;
alter table companion_private.tool_requests enable row level security;
alter table companion_private.tool_requests force row level security;
alter table companion_private.tool_calls enable row level security;
alter table companion_private.tool_calls force row level security;
revoke all on companion_private.tool_servers, companion_private.companion_tools, companion_private.tool_requests,
  companion_private.tool_calls from public, anon, authenticated;

-- A deleted Companion, and every Companion of a closed account, lets go of its tool tokens.
create function companion_private.companion_tools_forget()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name = 'companions' then
    delete from companion_private.companion_tools where companion_id = new.id;
  else
    delete from companion_private.companion_tools k using public.companions c where c.id = k.companion_id and c.owner_id = new.id;
  end if;
  return new;
end $$;
create trigger companion_tools_forget after update of status on public.companions
  for each row when (new.status = 'DELETED' and old.status is distinct from 'DELETED') execute function companion_private.companion_tools_forget();
create trigger owner_tools_forget after update of status on public.owners
  for each row when (new.status = 'DELETED' and old.status is distinct from 'DELETED') execute function companion_private.companion_tools_forget();

-- ---------- for the Owner ----------

-- As in 0070, plus companionTools: Companions may use the tools their Owners connected.
create or replace function public.platform_features()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('groupChatCreate', companion_private.feature_on('GROUP_CHAT_CREATE'),
    'groupChatSend', companion_private.feature_on('GROUP_CHAT_SEND'),
    'voiceInput', companion_private.feature_on('VOICE_INPUT'),
    'companionReach', companion_private.feature_on('COMPANION_REACH'),
    'companionTools', companion_private.feature_on('COMPANION_TOOLS'))
$$;

create function companion_private.tool_server_json(s companion_private.tool_servers)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', s.id, 'key', s.key, 'title', s.title, 'summary', s.summary, 'url', s.url, 'tokenHelp', s.token_help)
$$;

-- The tools of a connection that a Companion may use now: those the server listed that are on one
-- of the operators' two lists, [{name, description, inputSchema, confirm}].
create function companion_private.tools_offered(s companion_private.tool_servers, p_tools jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', t->>'name', 'description', coalesce(t->>'description', ''),
      'inputSchema', coalesce(t->'inputSchema', '{"type":"object"}'::jsonb), 'confirm', (t->>'name') = any(s.confirm_tools)) order by n), '[]')
  from jsonb_array_elements(p_tools) with ordinality x(t, n)
  where (t->>'name') = any(s.read_tools) or (t->>'name') = any(s.confirm_tools)
$$;

-- A request as its Owner sees it on the reply. status: PENDING while it waits for the Owner's
-- answer, EXPIRED when none came within 15 minutes, RUNNING while the call is made (a call that did
-- not come back within 2 minutes reads as FAILED), DONE, FAILED, DECLINED. result: what the tool
-- answered, for DONE and FAILED.
create function companion_private.tool_request_json(t companion_private.tool_requests)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', t.id, 'server', s.title, 'tool', t.tool, 'arguments', t.arguments,
    'status', case when t.status = 'PENDING' and t.created_at < now() - interval '15 minutes' then 'EXPIRED'
      when t.status = 'RUNNING' and t.decided_at < now() - interval '2 minutes' then 'FAILED' else t.status end,
    'result', t.result, 'createdAt', t.created_at)
  from companion_private.tool_servers s where s.id = t.server_id
$$;

-- The tool servers on offer, in the operators' order.
create function public.tool_server_list()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform companion_private.chat_owner(); -- signed-in Owners only
  return jsonb_build_object('items', coalesce((select jsonb_agg(companion_private.tool_server_json(s) order by s.position, s.title, s.id)
    from companion_private.tool_servers s where s.enabled), '[]'));
end $$;

-- What the Companion is connected to: each server, the token's last characters, and the tools it
-- may use there now (confirm: only after the Owner says yes). A server the operators switched off
-- is listed with available false and no tools.
create function public.companion_tool_list(p_companion uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return jsonb_build_object('maxServers', 3,
    'items', coalesce((select jsonb_agg(jsonb_build_object('server', companion_private.tool_server_json(s), 'available', s.enabled,
        'tokenHint', k.secret_hint, 'connectedAt', k.created_at,
        'tools', case when s.enabled then (select coalesce(jsonb_agg(o - 'inputSchema'), '[]')
          from jsonb_array_elements(companion_private.tools_offered(s, k.tools)) o) else '[]'::jsonb end) order by k.created_at, s.id)
      from companion_private.companion_tools k join companion_private.tool_servers s on s.id = k.server_id
      where k.companion_id = c), '[]'));
end $$;

-- Server only: connects the Companion to a server (or renews the token and the list of tools), after
-- the API server has reached the tool server with the token. A fourth server is refused.
create function public.companion_tool_save(p_companion uuid, p_server uuid, p_secret text, p_hint text, p_tools jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.locked_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  if not exists(select 1 from companion_private.tool_servers where id = p_server and enabled) then
    raise exception using errcode='P0001', message='tool server not found';
  end if;
  if not exists(select 1 from companion_private.companion_tools where companion_id = c and server_id = p_server)
    and (select count(*) from companion_private.companion_tools where companion_id = c) >= 3 then
    raise exception using errcode='55000', message='tool server limit reached';
  end if;
  insert into companion_private.companion_tools as k (companion_id, server_id, secret, secret_hint, tools)
    values (c, p_server, p_secret, p_hint, p_tools)
    on conflict (companion_id, server_id) do update set secret = excluded.secret, secret_hint = excluded.secret_hint,
      tools = excluded.tools, listed_at = now();
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'TOOL_CONNECT', 'TOOL_SERVER', p_server);
  return public.companion_tool_list(c);
end $$;

-- Disconnects; the sealed token is deleted, and so are requests still waiting for an answer.
create function public.companion_tool_delete(p_companion uuid, p_server uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  delete from companion_private.companion_tools where companion_id = c and server_id = p_server;
  if not found then raise exception using errcode='P0001', message='tool server not found'; end if;
  update companion_private.tool_requests set status = 'DECLINED', decided_at = now()
    where companion_id = c and server_id = p_server and status = 'PENDING';
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'TOOL_DISCONNECT', 'TOOL_SERVER', p_server);
  return public.companion_tool_list(c);
end $$;

-- The Owner says no to a request that waits. The Companion learns of it with the next message.
create function public.tool_request_decline(p_chat uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; t companion_private.tool_requests%rowtype;
begin
  c := companion_private.chat_for(p_chat);
  update companion_private.tool_requests r set status = 'DECLINED', decided_at = now()
    from companion_private.chat_messages m
    where r.id = p_request and m.id = r.message_id and m.chat_id = c.id and r.status = 'PENDING' returning r.* into t;
  if not found then raise exception using errcode='55000', message='request is not waiting'; end if;
  return companion_private.tool_request_json(t);
end $$;

-- ---------- for the API server only (companion_api) ----------

-- Tool calls made for the signed-in Owner's Companions today (UTC).
create function companion_private.tool_calls_used()
returns bigint language sql stable security definer set search_path='' as $$
  select count(*) from companion_private.tool_calls
  where owner_id = companion_private.chat_owner() and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
$$;

-- What a turn needs to use the Companion's tools: each connected server that is on offer, with
-- its address, the sealed token and the tools it may use (with their schemas), and how many calls
-- the Owner has left today. Nothing while the operators' switch is off.
create function public.companion_tool_secrets(p_companion uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return jsonb_build_object(
    'left', greatest(0, (select q.daily_tool_calls from companion_private.chat_quota q) - companion_private.tool_calls_used()),
    'servers', case when not companion_private.feature_on('COMPANION_TOOLS') then '[]'::jsonb else
      coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'title', s.title, 'url', s.url, 'secret', k.secret,
          'tools', companion_private.tools_offered(s, k.tools)) order by k.created_at, s.id)
        from companion_private.companion_tools k join companion_private.tool_servers s on s.id = k.server_id
        where k.companion_id = c and s.enabled), '[]') end);
end $$;

-- Notes one call made for the Companion (for the day's limit, and so it can be looked up later
-- that the Companion did call this tool). Never what was sent or what came back.
create function public.tool_call_note(p_companion uuid, p_server_key text, p_tool text, p_ok boolean)
returns void language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  insert into companion_private.tool_calls(owner_id, companion_id, server_key, tool, ok)
    values (companion_private.chat_owner(), c, left(p_server_key, 31), left(p_tool, 100), coalesce(p_ok, false));
end $$;

-- During a turn: keeps a call the Owner has to confirm, on the reply being written. The turn must
-- be the caller's claim; the tool must be a confirm tool of a server the Companion is connected to.
-- A second request in the same turn takes the place of the first.
create function public.tool_request_open(p_reply uuid, p_claim uuid, p_server uuid, p_tool text, p_arguments jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); m companion_private.chat_messages%rowtype; v_id uuid;
begin
  select x.* into m from companion_private.chat_messages x join companion_private.chats c on c.id = x.chat_id
    where x.id = p_reply and x.claim_id = p_claim and x.status = 'PENDING' and c.owner_id = o;
  if not found then raise exception using errcode='55000', message='the turn moved on'; end if;
  if p_arguments is null or jsonb_typeof(p_arguments) <> 'object' or pg_column_size(p_arguments) > 20000
    or not exists(select 1 from companion_private.companion_tools k join companion_private.tool_servers s on s.id = k.server_id
      where k.companion_id = m.companion_id and s.id = p_server and s.enabled and p_tool = any(s.confirm_tools)
        and exists(select 1 from jsonb_array_elements(k.tools) t where t->>'name' = p_tool)) then
    raise exception using errcode='22023', message='invalid request';
  end if;
  insert into companion_private.tool_requests as r (message_id, companion_id, server_id, tool, arguments)
    values (m.id, m.companion_id, p_server, p_tool, p_arguments)
    on conflict (message_id) do update set server_id = excluded.server_id, tool = excluded.tool, arguments = excluded.arguments,
      status = 'PENDING', result = null, created_at = now(), decided_at = null
    returning r.id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- The Owner said yes: takes a waiting request of this chat to make the call (it is RUNNING from
-- here on, so it is made once). Returns where to call and with what. Refused when the request is
-- not waiting any more, came more than 15 minutes ago, its reply was not sent, the Companion is no
-- longer connected, the tool is no longer a confirm tool, or the day's calls are used up.
create function public.tool_request_take(p_chat uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; t companion_private.tool_requests%rowtype; v jsonb;
begin
  c := companion_private.chat_for(p_chat);
  select r.* into t from companion_private.tool_requests r join companion_private.chat_messages m on m.id = r.message_id
    where r.id = p_request and m.chat_id = c.id and m.status = 'SENT' and r.status = 'PENDING'
      and r.created_at > now() - interval '15 minutes' for update of r;
  if not found or not companion_private.feature_on('COMPANION_TOOLS') then
    raise exception using errcode='55000', message='request is not waiting';
  end if;
  select jsonb_build_object('id', t.id, 'companionId', t.companion_id, 'serverKey', s.key, 'url', s.url, 'secret', k.secret,
      'tool', t.tool, 'arguments', t.arguments) into v
    from companion_private.companion_tools k join companion_private.tool_servers s on s.id = k.server_id
    where k.companion_id = t.companion_id and s.id = t.server_id and s.enabled and t.tool = any(s.confirm_tools);
  if v is null then raise exception using errcode='55000', message='request is not waiting'; end if;
  if companion_private.tool_calls_used() >= (select q.daily_tool_calls from companion_private.chat_quota q) then
    raise exception using errcode='55000', message='tool call limit reached';
  end if;
  update companion_private.tool_requests set status = 'RUNNING', decided_at = now() where id = t.id;
  return v;
end $$;

-- The call of a confirmed request came back (p_ok) or failed: the result is kept with it, and the
-- Companion gets a turn to tell the Owner, unless one is waiting already.
create function public.tool_request_finish(p_request uuid, p_ok boolean, p_result text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); t companion_private.tool_requests%rowtype; c companion_private.chats%rowtype;
begin
  select r.* into t from companion_private.tool_requests r join companion_private.chat_messages m on m.id = r.message_id
    join companion_private.chats x on x.id = m.chat_id
    where r.id = p_request and x.owner_id = o and r.status = 'RUNNING' for update of r;
  if not found then raise exception using errcode='55000', message='request is not running'; end if;
  update companion_private.tool_requests set status = case when coalesce(p_ok, false) then 'DONE' else 'FAILED' end,
    result = left(coalesce(p_result, ''), 4000) where id = t.id returning * into t;
  select x.* into c from companion_private.chats x join companion_private.chat_messages m on m.chat_id = x.id where m.id = t.message_id;
  c := companion_private.chat_for(c.id);
  if companion_private.chat_companion_ok(c.owner_id, t.companion_id)
    and not exists(select 1 from companion_private.chat_messages x where x.chat_id = c.id and x.companion_id = t.companion_id and x.status = 'PENDING') then
    insert into companion_private.chat_messages(chat_id, companion_id, status, reply_to, optional, typing_at)
      values (c.id, t.companion_id, 'PENDING', 'OWNER', false, now() + companion_private.chat_seconds(1));
    update companion_private.chats set active_at = now() where id = c.id returning * into c;
  end if;
  return jsonb_build_object('request', companion_private.tool_request_json(t)) || companion_private.chat_progress(c);
end $$;

-- As in 0086, plus toolRequest: a call this reply asks the Owner to confirm, or null.
create or replace function companion_private.chat_message_json(m companion_private.chat_messages)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id', m.id, 'companionId', m.companion_id, 'body', m.body, 'action', m.action,
    'mentions', to_jsonb(m.mentions), 'status', m.status, 'failure', m.failure,
    'connectionFailure', case when m.status = 'FAILED' and m.failure = 'ERROR' then m.failure_detail end,
    'retryable', m.status = 'FAILED' and m.failure = 'ERROR', 'sentAt', m.shown_at,
    'audio', (select jsonb_build_object('durationMs', a.duration_ms) from companion_private.chat_audio a where a.message_id = m.id),
    'images', coalesce((select jsonb_agg(jsonb_build_object('path', i.object_name, 'width', i.width, 'height', i.height,
        'seen', case when i.description is not null then true when i.attempts >= 2 then false end) order by i.position)
      from companion_private.chat_images i where i.message_id = m.id), '[]'),
    'reminder', (select companion_private.chat_reminder_json(r) from companion_private.chat_reminders r
      where r.message_id = m.id order by r.created_at, r.id limit 1),
    'toolRequest', (select companion_private.tool_request_json(t) from companion_private.tool_requests t where t.message_id = m.id),
    'reach', case m.reply_to when 'SELF' then 'GREETING' when 'REMINDER' then 'REMINDER' end)
$$;

-- As in 0086, plus canUseTools, and on each message of the history its request (the server's
-- name, the tool, how it ended and what it returned).
create or replace function public.chat_claim(p_chat uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; claim uuid := gen_random_uuid();
  skipped boolean := false; r companion_private.chat_reminders%rowtype; reach boolean;
begin
  c := companion_private.chat_for(p_chat);
  if exists(select 1 from companion_private.chat_messages where chat_id = c.id and status = 'PENDING'
      and claimed_at > now() - interval '2 minutes') then
    return null;
  end if;
  loop
    select x.* into m from companion_private.chat_messages x
      join companion_private.chat_members mm on mm.chat_id = x.chat_id and mm.companion_id = x.companion_id
      where x.chat_id = c.id and x.status = 'PENDING' order by x.created_at, mm.position, x.id limit 1;
    if not found then
      if not skipped then return null; end if;
      -- A skipped turn ends like a finished one: another Companion may answer what was said.
      -- That queues at most one turn for a Companion that can take part, so this ends.
      skipped := false;
      perform companion_private.chat_queue_followup(c);
      continue;
    end if;
    perform companion_private.chat_abandon_compute(c.owner_id, m.compute_tx);
    r := null;
    if m.reply_to = 'REMINDER' then
      select * into r from companion_private.chat_reminders where turn_id = m.id and status = 'WAITING';
    end if;
    exit when m.attempts < 3 and companion_private.chat_companion_ok(c.owner_id, m.companion_id)
      and not (m.reply_to = 'SELF' and (m.created_at < now() - interval '10 minutes'
        or exists(select 1 from companion_private.chat_messages h
          where h.chat_id = c.id and h.companion_id is null and h.status = 'SENT' and h.created_at > m.created_at)))
      and not (m.reply_to = 'REMINDER' and r.id is null);
    if m.optional then
      update companion_private.chat_messages set status = 'PASSED', shown_at = now(), typing_at = null, claim_id = null,
        compute_tx = null where id = m.id;
      update companion_private.chat_reminders set turn_id = null where turn_id = m.id and status = 'WAITING';
    else
      update companion_private.chat_messages set status = 'FAILED', shown_at = now(), typing_at = null, claim_id = null,
        compute_tx = null, failure = case when m.attempts >= 3 then 'ERROR' else 'UNAVAILABLE' end where id = m.id;
    end if;
    skipped := true;
  end loop;
  update companion_private.chat_messages set claim_id = claim, claimed_at = now(), attempts = attempts + 1, compute_tx = null
    where id = m.id;
  reach := m.reply_to = 'OWNER' and c.direct_companion_id is not null and companion_private.feature_on('COMPANION_REACH');
  return jsonb_build_object('chatId', c.id, 'replyId', m.id, 'claimId', claim, 'replyTo', m.reply_to,
    'optional', m.optional, 'direct', c.direct_companion_id is not null,
    'companion', companion_private.chat_companion_json(m.companion_id)
      || jsonb_build_object('identity', (select i.identity_document from public.companions x
        join public.companion_identities i on i.id = x.current_identity_version_id where x.id = m.companion_id))
      || jsonb_build_object('settings', companion_private.chat_settings_json(companion_private.chat_settings_for(m.companion_id))),
    'members', companion_private.chat_members_json(c.id),
    'history', coalesce((select jsonb_agg(jsonb_build_object('companionId', q.companion_id, 'body', q.body, 'action', q.action,
        'mentions', to_jsonb(q.mentions), 'sentAt', q.shown_at,
        'voice', exists(select 1 from companion_private.chat_audio a where a.message_id = q.id),
        'images', (select jsonb_agg(jsonb_build_object('path', i.object_name, 'description', i.description, 'tries', i.attempts) order by i.position)
          from companion_private.chat_images i where i.message_id = q.id),
        'toolRequest', (select companion_private.tool_request_json(t) - 'id' - 'arguments' from companion_private.tool_requests t where t.message_id = q.id))
        order by q.shown_at, q.id)
      from (select * from companion_private.chat_messages h where h.chat_id = c.id and h.status = 'SENT'
        -- The Owner's actions in a row read as the last of them, so taps cannot push the conversation out of the 30.
        and (h.action is null or h.companion_id is not null or coalesce((select n.action is null or n.companion_id is not null
          from companion_private.chat_messages n
          where n.chat_id = h.chat_id and n.status = 'SENT' and (n.shown_at, n.id) > (h.shown_at, h.id)
          order by n.shown_at, n.id limit 1), true))
        order by h.shown_at desc, h.id desc limit 30) q), '[]'),
    'canAct', c.direct_companion_id is not null and companion_private.feature_on('COMPANION_ACTIONS'),
    'reach', case m.reply_to when 'SELF' then jsonb_build_object('kind', 'GREETING')
      when 'REMINDER' then jsonb_build_object('kind', 'REMINDER', 'note', r.note, 'dueAt', r.due_at) end,
    'canRemind', reach,
    'canBrowse', m.reply_to = 'OWNER' and companion_private.feature_on('COMPANION_WEB'),
    'canUseTools', m.reply_to = 'OWNER' and c.direct_companion_id is not null and companion_private.feature_on('COMPANION_TOOLS'),
    'reminders', case when reach then coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'dueAt', q.due_at, 'note', q.note)
        order by q.due_at, q.id)
      from (select * from companion_private.chat_reminders w where w.companion_id = m.companion_id and w.status = 'WAITING'
        and w.turn_id is null and w.due_at > now() - interval '24 hours' order by w.due_at, w.id limit 20) q), '[]') else '[]'::jsonb end)
    || companion_private.chat_owner_context(c.owner_id, m.companion_id);
end $$;

-- ---------- for the operators ----------

-- The directory: every server, with how many Companions are connected and the calls of the last 7 days.
create function companion_admin.tool_servers()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'title', s.title, 'summary', s.summary, 'url', s.url,
      'tokenHelp', s.token_help, 'readTools', to_jsonb(s.read_tools), 'confirmTools', to_jsonb(s.confirm_tools), 'enabled', s.enabled,
      'position', s.position, 'updatedAt', s.updated_at,
      'connected', (select count(*) from companion_private.companion_tools k where k.server_id = s.id),
      'calls', (select count(*) from companion_private.tool_calls x where x.server_key = s.key and x.created_at > now() - interval '7 days'),
      'failed', (select count(*) from companion_private.tool_calls x where x.server_key = s.key and not x.ok and x.created_at > now() - interval '7 days'))
    order by s.position, s.title, s.id), '[]')
  from companion_private.tool_servers s
$$;

-- Saves a server of the directory (p_id null: a new one). Switched off, it is offered to nobody
-- and its tools are not used; the Owners' tokens are kept for when it is switched on again.
create function companion_admin.tool_server_set(p_id uuid, p_key text, p_title text, p_summary text, p_url text, p_token_help text,
  p_read_tools text[], p_confirm_tools text[], p_position integer, p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid()); v_before jsonb;
begin
  select to_jsonb(s) - 'id' - 'updated_at' into v_before from companion_private.tool_servers s where s.id = p_id for update;
  if p_id is not null and v_before is null then raise exception using errcode='P0001', message='tool server not found'; end if;
  insert into companion_private.tool_servers as s (id, key, title, summary, url, token_help, read_tools, confirm_tools, position, enabled)
    values (v_id, btrim(p_key), btrim(p_title), btrim(p_summary), btrim(p_url), btrim(p_token_help, E' \t\r\n'),
      coalesce(p_read_tools, '{}'), coalesce(p_confirm_tools, '{}'), coalesce(p_position, 0), coalesce(p_enabled, true))
    on conflict (id) do update set key = excluded.key, title = excluded.title, summary = excluded.summary, url = excluded.url,
      token_help = excluded.token_help, read_tools = excluded.read_tools, confirm_tools = excluded.confirm_tools,
      position = excluded.position, enabled = excluded.enabled, updated_at = now();
  perform companion_private.admin_note('TOOL_SERVER_SET', 'TOOL_SERVER', v_id::text, null, p_reason,
    jsonb_build_object('before', v_before, 'key', btrim(p_key), 'url', btrim(p_url), 'readTools', to_jsonb(coalesce(p_read_tools, '{}')),
      'confirmTools', to_jsonb(coalesce(p_confirm_tools, '{}')), 'enabled', coalesce(p_enabled, true)));
end $$;

revoke all on function companion_private.companion_tools_forget(), companion_private.tool_server_json(companion_private.tool_servers),
  companion_private.tools_offered(companion_private.tool_servers, jsonb), companion_private.tool_request_json(companion_private.tool_requests),
  companion_private.tool_calls_used(), public.tool_server_list(), public.companion_tool_list(uuid),
  public.companion_tool_save(uuid, uuid, text, text, jsonb), public.companion_tool_delete(uuid, uuid),
  public.tool_request_decline(uuid, uuid), public.companion_tool_secrets(uuid), public.tool_call_note(uuid, text, text, boolean),
  public.tool_request_open(uuid, uuid, uuid, text, jsonb), public.tool_request_take(uuid, uuid), public.tool_request_finish(uuid, boolean, text),
  companion_admin.tool_servers(), companion_admin.tool_server_set(uuid, text, text, text, text, text, text[], text[], integer, boolean, text)
  from public, anon, authenticated;
grant execute on function public.tool_server_list(), public.companion_tool_list(uuid), public.companion_tool_delete(uuid, uuid),
  public.tool_request_decline(uuid, uuid) to authenticated;
grant execute on function public.companion_tool_save(uuid, uuid, text, text, jsonb), public.companion_tool_secrets(uuid),
  public.tool_call_note(uuid, text, text, boolean), public.tool_request_open(uuid, uuid, uuid, text, jsonb),
  public.tool_request_take(uuid, uuid), public.tool_request_finish(uuid, boolean, text) to companion_api;
grant execute on function companion_admin.tool_servers(),
  companion_admin.tool_server_set(uuid, text, text, text, text, text, text[], text[], integer, boolean, text) to companion_admin;

-- ---------- a first server, for the operators to keep right ----------

-- McDonald's China (麦当劳). The address and the tool names are from the README of
-- github.com/M-China/mcd-mcp-server as read on 2026-11-28; they were not tried against the real
-- server from here. Left out on purpose: the points mall, the lottery and party bookings.
insert into companion_private.tool_servers(key, title, summary, url, token_help, read_tools, confirm_tools, position) values
  ('mcdonalds-cn', '麦当劳', '查菜单和优惠、算价格、下外卖单；付款由你自己在麦当劳完成', 'https://mcp.mcd.cn',
   '用手机号登录 open.mcd.cn/mcp，点右上角“控制台”，点“激活”并同意服务协议，复制 MCP Token 粘贴到这里。这个 Token 代表你的麦当劳会员身份，请只在你信任的地方填写。',
   array['now-time-info', 'delivery-query-addresses', 'delivery-query-stores', 'query-nearby-stores', 'query-meals', 'query-meal-detail',
     'query-store-coupons', 'calculate-price', 'query-order', 'order-list', 'query-my-coupons', 'available-coupons', 'query-my-account',
     'campaign-calendar', 'list-nutrition-foods'],
   array['create-order', 'cancel-order', 'delivery-create-address', 'auto-bind-coupons'], 10);

insert into companion_private.schema_migrations(name) values ('202611280087_companion_tools');

commit;
