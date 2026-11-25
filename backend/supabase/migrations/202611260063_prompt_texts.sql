begin;

-- The operators' own wording of the rules a model is told (admin console, 家机说明).
--
-- Most of what a Companion is told is written in the server (backend/src/chat/prompt.ts). The parts
-- about how to talk and what to write are named blocks (backend/src/chat/prompt-texts.ts) that the
-- operators can reword here. No row for a block: its built-in wording.
--
-- The server knows which blocks exist and what a wording must contain (a mark it looks for in the
-- answer), and checks both when saving and again when using a wording; the database keeps what
-- was saved. Every change is in the admin log with the wording before and after, so any earlier
-- one can be read there and saved again.

create table companion_private.prompt_texts (
  key text primary key check (key ~ '^[A-Z][A-Z_]{0,39}$'),
  body text not null check (char_length(body) between 1 and 1000),
  updated_at timestamptz not null default now()
);
alter table companion_private.prompt_texts enable row level security;
alter table companion_private.prompt_texts force row level security;
revoke all on companion_private.prompt_texts from public, anon, authenticated;

-- Server only: every saved wording, as {key: text}. Read before each model call, so a change in
-- the console holds from the next reply on.
create function public.prompt_texts()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(key, body), '{}') from companion_private.prompt_texts
$$;

-- Operators: every saved wording with when it was saved, as {key: {body, updatedAt}}.
create function companion_admin.prompts()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(key, jsonb_build_object('body', body, 'updatedAt', updated_at)), '{}')
  from companion_private.prompt_texts
$$;

-- Operators: save a wording for a block, or (null) go back to the built-in one. With a reason, logged.
create function companion_admin.prompt_set(p_key text, p_body text, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_before text;
begin
  select body into v_before from companion_private.prompt_texts where key = p_key for update;
  if p_body is null then
    if v_before is null then raise exception using errcode='55000', message='already the built-in wording'; end if;
    delete from companion_private.prompt_texts where key = p_key;
  else
    insert into companion_private.prompt_texts as t (key, body) values (p_key, p_body)
      on conflict (key) do update set body = excluded.body, updated_at = now();
  end if;
  perform companion_private.admin_note('PROMPT_SET', 'PROMPT', p_key, null, p_reason,
    jsonb_build_object('before', v_before, 'body', p_body));
end $$;

revoke all on function public.prompt_texts(), companion_admin.prompts(), companion_admin.prompt_set(text, text, text)
  from public, anon, authenticated;
grant execute on function public.prompt_texts() to companion_api;
grant execute on function companion_admin.prompts(), companion_admin.prompt_set(text, text, text) to companion_admin;

commit;
