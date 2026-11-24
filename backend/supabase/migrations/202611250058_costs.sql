-- Everything the platform pays for, in one place (the admin console's 花费 page).
--
--  * AI models: already booked per call in the compute ledger (companion_admin.spend).
--  * Voice: each call to the speech provider is written to companion_private.voice_usage by the
--    API server (public.voice_usage_add): SPEAK = characters as the provider billed them,
--    HEAR = milliseconds of the Owner's recording. Kept apart from chat_audio, whose clips are
--    deleted after voice_keep_days and with their chat.
--  * Prices (companion_private.voice_prices): the speech plan's monthly points, what a point costs
--    past the plan, and what an hour of recognition costs. Fixed monthly bills (servers, database,
--    the speech plan) are typed in by an operator (companion_private.fixed_costs).
-- All money here is in USD, in cents (fractions of a cent allowed for voice).
begin;

create table companion_private.voice_usage (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  kind text not null check (kind in ('SPEAK', 'HEAR')),
  amount integer not null check (amount between 0 and 10000000),
  created_at timestamptz not null default now()
);
create index voice_usage_time on companion_private.voice_usage(created_at);

create table companion_private.voice_prices (
  singleton boolean primary key default true check (singleton),
  plan_points integer not null check (plan_points between 0 and 1000000000),
  speak_cents_per_million numeric not null check (speak_cents_per_million between 0 and 100000000),
  hear_cents_per_hour numeric not null check (hear_cents_per_hour between 0 and 1000000),
  updated_at timestamptz not null default now()
);
-- MiniMax (platform.minimax.io, 2026-11): Starter plan 100,000 points a month; speech-2.8-hd
-- 100 USD per million characters; speech recognition 0.38 USD per hour.
insert into companion_private.voice_prices(plan_points, speak_cents_per_million, hear_cents_per_hour) values (100000, 10000, 38);

create table companion_private.fixed_costs (
  item text primary key check (char_length(item) between 1 and 60),
  cents_per_month bigint not null check (cents_per_month between 0 and 100000000),
  note text check (char_length(note) <= 200),
  updated_at timestamptz not null default now()
);
insert into companion_private.fixed_costs(item, cents_per_month, note) values ('MiniMax 语音包月(Starter)', 500, '含每月 100,000 点');

do $$ declare t text; begin
  foreach t in array array['voice_usage', 'voice_prices', 'fixed_costs'] loop
    execute format('alter table companion_private.%I enable row level security', t);
    execute format('alter table companion_private.%I force row level security', t);
    execute format('revoke all on companion_private.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- The API server, after each call to the speech provider, for the Owner it served.
create function public.voice_usage_add(p_kind text, p_amount integer)
returns void language sql security definer set search_path='' as $$
  insert into companion_private.voice_usage(owner_id, kind, amount)
    values (companion_private.chat_owner(), p_kind, greatest(coalesce(p_amount, 0), 0))
$$;

-- One month (UTC), everything the platform paid for: per day, in total, and the fixed bills.
create function companion_admin.costs(p_month date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  p companion_private.voice_prices%rowtype;
  v_models jsonb;
  v_days jsonb;
  v_model_cents numeric; v_points bigint; v_fixed bigint;
begin
  select * into p from companion_private.voice_prices;
  v_models := companion_admin.spend(v_from, v_to);
  with model as (
    select (d->>'day')::date as day, sum((d->>'costMinor')::numeric) as cents, sum((d->>'calls')::bigint) as calls
    from jsonb_array_elements(v_models->'byDay') d where d->>'currency' = 'USD' group by 1),
  voice as (
    select (created_at at time zone 'UTC')::date as day,
      sum(amount) filter (where kind = 'HEAR') as hear_ms, count(*) filter (where kind = 'HEAR') as hears,
      sum(amount) filter (where kind = 'SPEAK') as points, count(*) filter (where kind = 'SPEAK') as speaks
    from companion_private.voice_usage
    where created_at >= v_from::timestamp at time zone 'UTC' and created_at < (v_to + 1)::timestamp at time zone 'UTC'
    group by 1)
  select coalesce(jsonb_agg(jsonb_build_object('day', x.day,
      'modelCents', coalesce(m.cents, 0), 'modelCalls', coalesce(m.calls, 0),
      'hearSeconds', round(coalesce(v.hear_ms, 0) / 1000.0), 'hears', coalesce(v.hears, 0),
      'hearCents', coalesce(v.hear_ms, 0) / 3600000.0 * p.hear_cents_per_hour,
      'speakPoints', coalesce(v.points, 0), 'speaks', coalesce(v.speaks, 0)) order by x.day desc), '[]')
    into v_days
  from (select day from model union select day from voice) x
  left join model m on m.day = x.day left join voice v on v.day = x.day;

  select coalesce(sum((d->>'modelCents')::numeric), 0), coalesce(sum((d->>'speakPoints')::bigint), 0)
    into v_model_cents, v_points from jsonb_array_elements(v_days) d;
  select coalesce(sum(cents_per_month), 0) into v_fixed from companion_private.fixed_costs;

  return jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'), 'from', v_from, 'to', v_to,
    'totals', jsonb_build_object(
      'modelCents', v_model_cents,
      'hearCents', (select coalesce(sum((d->>'hearCents')::numeric), 0) from jsonb_array_elements(v_days) d),
      'speakPoints', v_points,
      'speakOverCents', greatest(v_points - p.plan_points, 0) / 1000000.0 * p.speak_cents_per_million,
      'fixedCents', v_fixed),
    'prices', jsonb_build_object('planPoints', p.plan_points, 'speakCentsPerMillion', p.speak_cents_per_million,
      'hearCentsPerHour', p.hear_cents_per_hour, 'updatedAt', p.updated_at),
    'fixed', coalesce((select jsonb_agg(jsonb_build_object('item', f.item, 'cents', f.cents_per_month, 'note', f.note,
        'updatedAt', f.updated_at) order by f.cents_per_month desc, f.item) from companion_private.fixed_costs f), '[]'),
    'days', v_days,
    'models', v_models);
end $$;

-- Adds or changes a fixed monthly bill; null cents removes it.
create function companion_admin.fixed_cost_set(p_item text, p_cents bigint, p_note text, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare f companion_private.fixed_costs%rowtype; v_item text := btrim(coalesce(p_item, ''));
begin
  select * into f from companion_private.fixed_costs where item = v_item for update;
  if p_cents is null then
    if not found then raise exception using errcode='P0001', message='fixed cost not found'; end if;
    delete from companion_private.fixed_costs where item = v_item;
  else
    insert into companion_private.fixed_costs(item, cents_per_month, note) values (v_item, p_cents, nullif(btrim(p_note), ''))
      on conflict (item) do update set cents_per_month = excluded.cents_per_month, note = excluded.note, updated_at = now();
  end if;
  perform companion_private.admin_note('FIXED_COST', 'FIXED_COST', v_item, null, p_reason, jsonb_build_object(
    'cents', p_cents, 'note', p_note, 'before', case when f.item is null then null else f.cents_per_month end));
end $$;

create function companion_admin.voice_prices_set(p_plan_points integer, p_speak_cents_per_million numeric,
  p_hear_cents_per_hour numeric, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare p companion_private.voice_prices%rowtype;
begin
  select * into p from companion_private.voice_prices for update;
  update companion_private.voice_prices set plan_points = p_plan_points, speak_cents_per_million = p_speak_cents_per_million,
    hear_cents_per_hour = p_hear_cents_per_hour, updated_at = now();
  perform companion_private.admin_note('VOICE_PRICES', 'VOICE_PRICES', 'prices', null, p_reason, jsonb_build_object(
    'planPoints', p_plan_points, 'speakCentsPerMillion', p_speak_cents_per_million, 'hearCentsPerHour', p_hear_cents_per_hour,
    'before', jsonb_build_object('planPoints', p.plan_points, 'speakCentsPerMillion', p.speak_cents_per_million,
      'hearCentsPerHour', p.hear_cents_per_hour)));
end $$;

revoke all on function public.voice_usage_add(text, integer), companion_admin.costs(date),
  companion_admin.fixed_cost_set(text, bigint, text, text), companion_admin.voice_prices_set(integer, numeric, numeric, text)
  from public, anon, authenticated;
grant execute on function public.voice_usage_add(text, integer) to companion_api;
grant execute on function companion_admin.costs(date), companion_admin.fixed_cost_set(text, bigint, text, text),
  companion_admin.voice_prices_set(integer, numeric, numeric, text) to companion_admin;

commit;
