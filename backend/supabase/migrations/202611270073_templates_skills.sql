begin;

-- Starting points and skills (人设模板、技能).
--
--   1. Persona templates: ready-made characters the operators write (a name, who it is, how it
--      talks, a few lines of example dialogue). The app lists them and hands the one the Owner
--      picked to the import an Owner's own card goes through (POST /v0/companion-imports), so a
--      template gets no path of its own into a Companion: it is a card we wrote.
--   2. Skills: a named piece of know-how ("英语陪练": when and how to do one thing), told to the
--      model with every chat reply of a Companion that has it switched on.
--        * official skills are written by the operators; an Owner switches them on per Companion
--          and is shown their title and summary. The wording is not shown, but it is no secret:
--          it goes to the model with the rest of the prompt, also to a model the Owner connected;
--        * an Owner writes skills of their own for one Companion (up to 10), scanned by the API
--          server before they are saved, like a persona text. They reach nobody else's Companion.
--      At most 5 skills are on for a Companion at a time: each is up to 600 characters of every reply.
--
-- Operators edit templates and official skills in the admin console; every change is in the log.

create table companion_private.persona_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 20 and title ~ '\S'),
  summary text not null check (char_length(summary) between 1 and 100 and summary ~ '\S'),
  -- The card: the Companion's name (the Owner may change it before importing), who it is, its nature, how it talks.
  -- In `example`, {{char}} stands for the name, so the lines follow a name the Owner chose.
  name text not null check (char_length(name) between 1 and 20 and name ~ '\S'),
  description text not null check (char_length(description) between 1 and 600 and description ~ '\S'),
  personality text not null check (char_length(personality) <= 600),
  example text not null check (char_length(example) <= 1500),
  position integer not null default 0,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table companion_private.skills (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 20 and title ~ '\S'),
  summary text not null check (char_length(summary) between 1 and 100 and summary ~ '\S'),
  body text not null check (char_length(body) between 1 and 600 and body ~ '\S'),
  position integer not null default 0,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- The official skills a Companion has switched on.
create table companion_private.companion_skills (
  companion_id uuid not null references public.companions(id) on delete cascade,
  skill_id uuid not null references companion_private.skills(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (companion_id, skill_id)
);

-- Skills an Owner wrote for one Companion.
create table companion_private.own_skills (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references public.companions(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 20 and title ~ '\S'),
  body text not null check (char_length(body) between 1 and 600 and body ~ '\S'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index own_skills_list on companion_private.own_skills(companion_id, created_at, id);

alter table companion_private.persona_templates enable row level security;
alter table companion_private.persona_templates force row level security;
alter table companion_private.skills enable row level security;
alter table companion_private.skills force row level security;
alter table companion_private.companion_skills enable row level security;
alter table companion_private.companion_skills force row level security;
alter table companion_private.own_skills enable row level security;
alter table companion_private.own_skills force row level security;
revoke all on companion_private.persona_templates, companion_private.skills, companion_private.companion_skills,
  companion_private.own_skills from public, anon, authenticated;

-- ---------- for the Owner ----------

-- The templates on offer, in the operators' order. `card` is a character card (chara_card_v2) to
-- hand to POST /v0/companion-imports, with the name changed first if the Owner wants another.
create function public.persona_template_list()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform companion_private.chat_owner(); -- signed-in Owners only
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'summary', t.summary,
      'card', jsonb_build_object('spec', 'chara_card_v2', 'spec_version', '2.0', 'data', jsonb_strip_nulls(jsonb_build_object(
        'name', t.name, 'description', t.description, 'personality', nullif(t.personality, ''), 'mes_example', nullif(t.example, '')))))
      order by t.position, t.title, t.id)
    from companion_private.persona_templates t where t.enabled), '[]'));
end $$;

create function companion_private.own_skill_json(s companion_private.own_skills)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', s.id, 'title', s.title, 'body', s.body, 'enabled', s.enabled, 'createdAt', s.created_at, 'updatedAt', s.updated_at)
$$;

-- How many skills are on for the Companion: official ones still on offer, and its own.
create function companion_private.skills_on(p_companion uuid)
returns integer language sql stable security definer set search_path='' as $$
  select (select count(*) from companion_private.companion_skills k join companion_private.skills s on s.id = k.skill_id
      where k.companion_id = p_companion and s.enabled)::integer
    + (select count(*) from companion_private.own_skills o where o.companion_id = p_companion and o.enabled)::integer
$$;

-- The official skills on offer (title and summary, and whether this Companion has each switched
-- on) and the Companion's own skills. maxEnabled: how many may be on at a time.
create function public.skill_list(p_companion uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return jsonb_build_object('maxEnabled', 5,
    'official', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'summary', s.summary,
        'enabled', exists(select 1 from companion_private.companion_skills k where k.companion_id = c and k.skill_id = s.id))
        order by s.position, s.title, s.id)
      from companion_private.skills s where s.enabled), '[]'),
    'own', coalesce((select jsonb_agg(companion_private.own_skill_json(o) order by o.created_at, o.id)
      from companion_private.own_skills o where o.companion_id = c), '[]'));
end $$;

-- Switches an official skill on or off for the Companion. A sixth one on is refused.
create function public.skill_set(p_companion uuid, p_skill uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.locked_companion(p_companion); -- first, so two requests cannot both count 4
  o uuid := companion_private.chat_owner();
begin
  if p_enabled is null then raise exception using errcode='22023', message='invalid skill'; end if;
  if not exists(select 1 from companion_private.skills where id = p_skill and enabled) then
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

-- Server only (the texts are scanned first). p_skill null: a new skill of the Companion's own (the
-- 11th is refused; one it already has word for word is returned as it is); else that one is
-- rewritten. Switching one on as the sixth is refused.
create function public.own_skill_save(p_companion uuid, p_skill uuid, p_title text, p_body text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.locked_companion(p_companion); o uuid := companion_private.chat_owner();
  s companion_private.own_skills%rowtype; v_title text := btrim(p_title); v_body text := btrim(p_body, E' \t\r\n'); was_on boolean := false;
begin
  if v_title is null or v_title !~ '\S' or char_length(v_title) > 20 or v_title ~ '[[:cntrl:]]'
    or v_body is null or v_body !~ '\S' or char_length(v_body) > 600 or p_enabled is null then
    raise exception using errcode='22023', message='invalid skill';
  end if;
  if p_skill is not null then
    select * into s from companion_private.own_skills where id = p_skill and companion_id = c;
    if not found then raise exception using errcode='P0001', message='skill not found'; end if;
    was_on := s.enabled;
  else
    -- The same skill sent again (a retry): the one that is there, and nothing new.
    select * into s from companion_private.own_skills where companion_id = c and title = v_title and body = v_body limit 1;
    if found then return companion_private.own_skill_json(s); end if;
    if (select count(*) from companion_private.own_skills where companion_id = c) >= 10 then
      raise exception using errcode='55000', message='own skill limit reached';
    end if;
  end if;
  if p_enabled and not was_on and companion_private.skills_on(c) >= 5 then
    raise exception using errcode='55000', message='skill limit reached';
  end if;
  if p_skill is null then
    insert into companion_private.own_skills(companion_id, title, body, enabled) values (c, v_title, v_body, p_enabled) returning * into s;
  else
    update companion_private.own_skills set title = v_title, body = v_body, enabled = p_enabled, updated_at = now()
      where id = p_skill returning * into s;
  end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'OWN_SKILL_SAVE', 'SKILL', s.id);
  return companion_private.own_skill_json(s);
end $$;

create function public.own_skill_delete(p_companion uuid, p_skill uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion); o uuid := companion_private.chat_owner();
begin
  delete from companion_private.own_skills where id = p_skill and companion_id = c;
  if not found then raise exception using errcode='P0001', message='skill not found'; end if;
  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'OWN_SKILL_DELETE', 'SKILL', p_skill);
  return jsonb_build_object('deleted', true);
end $$;

-- Server only: the skills that are on for the Companion, as the model is told them: [{title, body}],
-- official ones first (in the operators' order), then its own (oldest first); 5 at most.
create function public.skill_texts(p_companion uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c uuid := companion_private.owned_companion(p_companion);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('title', q.title, 'body', q.body) order by q.rank, q.place, q.id) from (
    select * from (
      select 0 as rank, s.position::numeric as place, s.id, s.title, s.body from companion_private.companion_skills k
        join companion_private.skills s on s.id = k.skill_id where k.companion_id = c and s.enabled
      union all
      select 1, extract(epoch from o.created_at), o.id, o.title, o.body from companion_private.own_skills o
        where o.companion_id = c and o.enabled) x
    order by x.rank, x.place, x.id limit 5) q), '[]');
end $$;

-- Same as in 0072, plus the Companion's skills.
create or replace function public.companion_delete(p_companion uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); c uuid; v_actor uuid;
begin
  perform 1 from public.owners where id = o for no key update;
  select id into c from public.companions
    where id = p_companion and owner_id = o and status not in ('DELETED', 'QUARANTINED') for update;
  if not found then raise exception using errcode='P0001', message='companion not found'; end if;
  update public.companions set status = 'DELETED', updated_at = now() where id = c;

  perform 1 from companion_private.chats x where x.direct_companion_id = c
    or exists(select 1 from companion_private.chat_members m where m.chat_id = x.id and m.companion_id = c) for update;
  -- Model calls still on the way are given up, so no budget or credits stay held.
  perform companion_private.chat_abandon_compute(o, m.compute_tx)
    from companion_private.chat_messages m where m.companion_id = c and m.compute_tx is not null;
  perform companion_private.chat_abandon_compute(o, e.compute_tx)
    from companion_private.diary_entries e where e.companion_id = c and e.compute_tx is not null;
  perform companion_private.chat_abandon_compute(o, r.compute_tx)
    from companion_private.agent_runs r where r.companion_id = c and r.compute_tx is not null;
  perform companion_private.chat_abandon_compute(o, n.compute_tx)
    from companion_private.memory_notes n where n.companion_id = c and n.compute_tx is not null;

  delete from companion_private.chats where direct_companion_id = c;
  delete from companion_private.chat_messages where companion_id = c;
  delete from companion_private.chat_members where companion_id = c;
  delete from companion_private.chats x where x.owner_id = o and x.direct_companion_id is null
    and not exists(select 1 from companion_private.chat_members m where m.chat_id = x.id);
  delete from companion_private.diary_entries where companion_id = c;
  delete from companion_private.diary_settings where companion_id = c;
  delete from companion_private.companion_memories where companion_id = c;
  delete from companion_private.memory_notes where companion_id = c;
  delete from companion_private.world_entries where companion_id = c;
  delete from companion_private.companion_skills where companion_id = c;
  delete from companion_private.own_skills where companion_id = c;
  delete from companion_private.companion_connections where companion_id = c;
  delete from companion_private.agent_keys where companion_id = c;
  delete from companion_private.agent_runs where companion_id = c;
  delete from companion_private.anniversaries where companion_id = c;
  delete from companion_private.chat_settings where companion_id = c;
  delete from public.life_event_inbox where owner_id = o and companion_id = c;

  select a.id into v_actor from public.community_actors a
    join public.social_twins t on t.id = a.social_twin_id where t.companion_id = c;
  if v_actor is not null then
    update public.community_posts set deleted_at = now(), body = '[已删除]' where actor_id = v_actor and deleted_at is null;
    update public.community_comments set deleted_at = now(), body = '[已删除]' where actor_id = v_actor and deleted_at is null;
    delete from public.community_follows where actor_id = v_actor or target_id = v_actor;
    delete from public.community_likes where actor_id = v_actor;
    delete from public.community_notifications where actor_id = v_actor or recipient_id = v_actor;
    delete from companion_private.agent_drafts where actor_id = v_actor;
  end if;

  insert into public.audit_events(owner_id, companion_id, actor_type, actor_id, action, target_type, target_id)
    values (o, c, 'OWNER', o, 'COMPANION_DELETE', 'COMPANION', c);
  return jsonb_build_object('deleted', true);
end $$;

-- ---------- for the operators ----------

-- Everything the console shows: every template, and every official skill with how many Companions have it on.
create function companion_admin.kit()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'summary', t.summary, 'name', t.name,
        'description', t.description, 'personality', t.personality, 'example', t.example, 'position', t.position,
        'enabled', t.enabled, 'updatedAt', t.updated_at) order by t.position, t.title, t.id)
      from companion_private.persona_templates t), '[]'),
    'skills', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'summary', s.summary, 'body', s.body,
        'position', s.position, 'enabled', s.enabled, 'updatedAt', s.updated_at,
        'usedBy', (select count(*) from companion_private.companion_skills k where k.skill_id = s.id)) order by s.position, s.title, s.id)
      from companion_private.skills s), '[]'),
    'ownSkills', (select count(*) from companion_private.own_skills))
$$;

-- Saves a template (p_id null: a new one). The console checks the texts first, the way an import would.
create function companion_admin.template_set(p_id uuid, p_title text, p_summary text, p_name text, p_description text,
  p_personality text, p_example text, p_position integer, p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid()); v_before jsonb;
begin
  select to_jsonb(t) - 'id' - 'updated_at' into v_before from companion_private.persona_templates t where t.id = p_id for update;
  if p_id is not null and v_before is null then raise exception using errcode='P0001', message='template not found'; end if;
  insert into companion_private.persona_templates as t (id, title, summary, name, description, personality, example, position, enabled)
    values (v_id, btrim(p_title), btrim(p_summary), btrim(p_name), btrim(p_description, E' \t\r\n'), btrim(coalesce(p_personality, ''), E' \t\r\n'),
      btrim(coalesce(p_example, ''), E' \t\r\n'), coalesce(p_position, 0), coalesce(p_enabled, true))
    on conflict (id) do update set title = excluded.title, summary = excluded.summary, name = excluded.name, description = excluded.description,
      personality = excluded.personality, example = excluded.example, position = excluded.position, enabled = excluded.enabled, updated_at = now();
  perform companion_private.admin_note('TEMPLATE_SET', 'TEMPLATE', v_id::text, null, p_reason,
    jsonb_build_object('before', v_before, 'title', btrim(p_title), 'enabled', coalesce(p_enabled, true)));
end $$;

create function companion_admin.template_delete(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_before jsonb;
begin
  delete from companion_private.persona_templates t where t.id = p_id returning to_jsonb(t) - 'id' - 'updated_at' into v_before;
  if v_before is null then raise exception using errcode='P0001', message='template not found'; end if;
  perform companion_private.admin_note('TEMPLATE_DELETE', 'TEMPLATE', p_id::text, null, p_reason, jsonb_build_object('before', v_before));
end $$;

-- Saves an official skill (p_id null: a new one). A skill switched off is told to nobody and offered
-- to nobody; the Companions that had it on get it back when it is switched on again.
create function companion_admin.skill_set(p_id uuid, p_title text, p_summary text, p_body text, p_position integer,
  p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid()); v_before jsonb;
begin
  select to_jsonb(s) - 'id' - 'updated_at' into v_before from companion_private.skills s where s.id = p_id for update;
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

-- Deletes an official skill; the Companions that had it on lose it.
create function companion_admin.skill_delete(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_before jsonb;
begin
  delete from companion_private.skills s where s.id = p_id returning to_jsonb(s) - 'id' - 'updated_at' into v_before;
  if v_before is null then raise exception using errcode='P0001', message='skill not found'; end if;
  perform companion_private.admin_note('SKILL_DELETE', 'SKILL', p_id::text, null, p_reason, jsonb_build_object('before', v_before));
end $$;

revoke all on function public.persona_template_list(), companion_private.own_skill_json(companion_private.own_skills),
  companion_private.skills_on(uuid), public.skill_list(uuid), public.skill_set(uuid, uuid, boolean),
  public.own_skill_save(uuid, uuid, text, text, boolean), public.own_skill_delete(uuid, uuid), public.skill_texts(uuid),
  companion_admin.kit(), companion_admin.template_set(uuid, text, text, text, text, text, text, integer, boolean, text),
  companion_admin.template_delete(uuid, text), companion_admin.skill_set(uuid, text, text, text, integer, boolean, text),
  companion_admin.skill_delete(uuid, text) from public, anon, authenticated;
grant execute on function public.persona_template_list(), public.skill_list(uuid), public.skill_set(uuid, uuid, boolean),
  public.own_skill_delete(uuid, uuid) to authenticated;
grant execute on function public.own_skill_save(uuid, uuid, text, text, boolean), public.skill_texts(uuid) to companion_api;
grant execute on function companion_admin.kit(), companion_admin.template_set(uuid, text, text, text, text, text, text, integer, boolean, text),
  companion_admin.template_delete(uuid, text), companion_admin.skill_set(uuid, text, text, text, integer, boolean, text),
  companion_admin.skill_delete(uuid, text) to companion_admin;

-- ---------- a first set, for the operators to reword ----------

insert into companion_private.persona_templates(title, summary, name, description, personality, example, position) values
  ('温柔的倾听者', '安静、耐心，先把话听完再说', '小满',
   '安静、耐心，喜欢听主人讲一天里的事。不急着给建议，先把话听完。', '温和、细心、慢热；记得小事；偶尔开个小玩笑',
   E'主人：今天好累\n{{char}}：辛苦啦。先坐一会儿，想说的时候我在听。', 10),
  ('元气的搭子', '精力充沛，爱聊吃的玩的，喜欢一起做计划', '阿橙',
   '精力充沛，爱聊吃的、玩的和新鲜事，喜欢拉着主人一起做计划。', '外向、爱笑、行动派；说话直接；有点话痨',
   E'主人：周末不知道干嘛\n{{char}}：那可太好办了！先说，想出门还是想瘫着？', 20),
  ('嘴硬心软的损友', '嘴上不饶人，心里很在意', '阿默',
   '嘴上不饶人，心里很在意主人。会吐槽，也会在主人真的难过时认真起来。', '毒舌、聪明、护短；不说肉麻的话；关心藏在吐槽里',
   E'主人：我又熬夜了\n{{char}}：行，黑眼圈是你自己选的。……明天早点睡，听见没。', 30),
  ('安静的书虫', '喜欢书和冷知识，话不多但有内容', '青禾',
   '喜欢书、电影和冷知识，说话不多但有内容，愿意陪主人慢慢想一件事。', '沉静、好奇、有条理；不敷衍；喜欢反问一个好问题',
   E'主人：最近不知道读什么\n{{char}}：上一本让你舍不得放下的书是哪本？从那儿找起。', 40);

insert into companion_private.skills(title, summary, body, position) values
  ('英语陪练', '用英语和你聊天，顺手纠正一处错误',
   '主人想练英语时（主人用英语说话，或者说“陪我练英语”），你用简单自然的英语回答，句子不要长。主人的句子里有明显的错误时，先正常接话，再用一句中文指出最重要的一处并给出正确说法；一次只纠正一处。主人换回中文，你也换回中文。', 10),
  ('睡前故事', '睡前给你讲一个安静的小故事',
   '主人说想听故事、睡不着或者要睡了时，可以讲一个你自己编的短故事：两到三条消息讲完，语气放轻放慢，情节平和，结尾安静，不留悬念。不讲恐怖和刺激的内容。讲完说一句晚安，不追问。', 20),
  ('面试陪练', '扮演面试官，陪你练面试',
   '主人说要准备面试时，先问清楚是什么岗位。然后你来当面试官：一次只问一个问题，等主人回答后，先说回答里最好的一点和最该改的一点，再问下一个。主人说“结束”时，总结三条最有用的建议。全程保持你平时的说话方式。', 30),
  ('只听不劝', '你倾诉时只倾听，不急着给建议',
   '主人在倾诉烦恼时，先听完，用你自己的话说出你听到的感受，让主人知道你听懂了。不急着给建议、不讲道理、不说“你应该”。只有主人明确问“我该怎么办”时才给一两条具体的建议。', 40);

insert into companion_private.schema_migrations(name) values ('202611270073_templates_skills');

commit;
