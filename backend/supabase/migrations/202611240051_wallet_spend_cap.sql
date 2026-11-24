begin;

-- Paying for platform models: a platform-wide daily spend cap, and an Owner wallet of credits.
--
-- 1. Platform daily cap (ADMIN_PLAN PR 3). Every platform model call is refused (DISABLED, reason
--    PLATFORM_LIMIT) once today's reserved + settled cost over all Owners would pass the cap.
--    Default: on, 20.00 USD per UTC day. Operators change it in the admin console.
-- 2. Owner wallet. Integer credits, free (gifts) and paid (purchases, later) kept apart. Off by
--    default (wallet_policy.enabled): while off, nothing is held or charged and chat works exactly
--    as before (only the free daily budget per Companion applies).
--    While on:
--      * every Owner gets the welcome gift once per welcome_version, on first use;
--      * a model call holds credits = reserved cost (cents) x credits_per_cent before it starts,
--        spending free credits first; too few: QUOTA, reason WALLET (FROZEN for a frozen wallet);
--      * background work (diary entries) must leave background_floor credits, so the chat keeps
--        something to answer with;
--      * when the call ends, the real cost is charged and the rest of the hold goes back. A call
--        that failed or whose outcome is unknown (server stopped mid-call) charges nothing: the
--        platform carries that, not the Owner.
--    Every change is one immutable row in wallet_entries; (owner, kind, request id) is unique,
--    so a repeated grant, purchase or refund books once. Purchases and refunds (App Store /
--    Google Play) use kinds PURCHASE / REFUND with the store's transaction id as request id; they
--    are not wired yet. Operators can add or remove free credits (ADJUST) with a reason.
-- 3. chat_reserve and diary_reserve now share one booking function (compute_book) that checks, in
--    order: model switch, platform cap, wallet, daily budget; then books, starts and holds.
--    Owner-key (BYOK) and own-agent calls are not booked: the Owner pays their own provider.
--
-- Credits and money are separate: credits_per_cent is the price; price_version names it and is
-- written on every hold.

-- ---------- platform daily cap ----------

create table companion_private.platform_spend_cap (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null,
  daily_cost_minor bigint not null check (daily_cost_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null default now()
);
insert into companion_private.platform_spend_cap(enabled, daily_cost_minor, currency) values (true, 2000, 'USD');

-- Reserved + settled cost of today's (UTC) budgets over every Owner, in the cap's currency.
create function companion_private.platform_spent_today()
returns bigint language sql stable security definer set search_path='' as $$
  select coalesce(sum(b.reserved_cost_minor + b.settled_cost_minor), 0)::bigint from public.compute_budgets b
  where b.period_start <= now() and now() < b.period_end
    and b.currency = (select currency from companion_private.platform_spend_cap)
$$;

-- ---------- wallet ----------

create table companion_private.wallet_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null,
  welcome_credits bigint not null check (welcome_credits between 0 and 100000000),
  welcome_version text not null check (welcome_version ~ '^[a-z0-9._/-]{1,40}$'),
  credits_per_cent integer not null check (credits_per_cent between 1 and 1000000),
  background_floor bigint not null check (background_floor between 0 and 100000000),
  updated_at timestamptz not null default now()
);
-- Placeholders until the platform decides: off; 1000 credits welcome gift (1.00 USD of model cost);
-- 10 credits per cent; diaries leave 200 credits for chat.
insert into companion_private.wallet_policy(enabled, welcome_credits, welcome_version, credits_per_cent, background_floor)
  values (false, 1000, 'welcome/1', 10, 200);

create function companion_private.wallet_price_version(p_credits_per_cent integer)
returns text language sql immutable as $$ select 'credits/' || p_credits_per_cent || '-per-cent' $$;

create table companion_private.wallets (
  owner_id uuid primary key references public.owners(id) on delete cascade,
  free_credits bigint not null default 0 check (free_credits >= 0),
  paid_credits bigint not null default 0 check (paid_credits >= 0),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'FROZEN')),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- No foreign key on owner_id: the history outlives the account (like admin_log).
create table companion_private.wallet_entries (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  kind text not null check (kind in ('GRANT', 'HOLD', 'RELEASE', 'PURCHASE', 'REFUND', 'ADJUST')),
  request_id text not null check (char_length(request_id) between 1 and 200),
  purpose text check (purpose is null or purpose in ('CHAT', 'DIARY')),
  companion_id uuid,
  delta_free bigint not null,
  delta_paid bigint not null,
  price_version text,
  note text check (note is null or char_length(note) <= 500),
  operator text,
  created_at timestamptz not null default now(),
  unique (owner_id, kind, request_id)
);
create index wallet_entries_owner on companion_private.wallet_entries(owner_id, id desc);
create trigger wallet_entries_immutable before update or delete on companion_private.wallet_entries
  for each row execute function companion_private.reject_immutable_mutation();

-- Credits taken for a model call that has not ended yet.
create table companion_private.wallet_holds (
  compute_tx uuid primary key references public.compute_transactions(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  free_held bigint not null check (free_held >= 0),
  paid_held bigint not null check (paid_held >= 0),
  credits_per_cent integer not null,
  purpose text not null,
  companion_id uuid not null,
  created_at timestamptz not null default now()
);

alter table companion_private.platform_spend_cap enable row level security;
alter table companion_private.platform_spend_cap force row level security;
alter table companion_private.wallet_policy enable row level security;
alter table companion_private.wallet_policy force row level security;
alter table companion_private.wallets enable row level security;
alter table companion_private.wallets force row level security;
alter table companion_private.wallet_entries enable row level security;
alter table companion_private.wallet_entries force row level security;
alter table companion_private.wallet_holds enable row level security;
alter table companion_private.wallet_holds force row level security;
revoke all on companion_private.platform_spend_cap, companion_private.wallet_policy, companion_private.wallets,
  companion_private.wallet_entries, companion_private.wallet_holds from public, anon, authenticated;

-- Adds credits (or takes them, negative) once per (owner, kind, request id); false if already booked.
-- The wallet must be locked by the caller.
create function companion_private.wallet_book(p_owner uuid, p_kind text, p_request text, p_free bigint, p_paid bigint,
  p_purpose text default null, p_companion uuid default null, p_price_version text default null, p_note text default null)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  insert into companion_private.wallet_entries(owner_id, kind, request_id, purpose, companion_id, delta_free, delta_paid,
      price_version, note, operator)
    values (p_owner, p_kind, p_request, p_purpose, p_companion, p_free, p_paid, p_price_version, p_note,
      case when p_kind = 'ADJUST' then session_user::text end)
    on conflict (owner_id, kind, request_id) do nothing;
  if not found then return false; end if;
  update companion_private.wallets set free_credits = free_credits + p_free, paid_credits = paid_credits + p_paid,
    version = version + 1, updated_at = now() where owner_id = p_owner;
  return true;
end $$;

-- The Owner's wallet, created on first use and locked. While the wallet is on, the welcome gift
-- of the current welcome_version is granted here, once.
create function companion_private.wallet_for(p_owner uuid)
returns companion_private.wallets language plpgsql security definer set search_path='' as $$
declare w companion_private.wallets%rowtype; p companion_private.wallet_policy%rowtype;
begin
  insert into companion_private.wallets(owner_id) values (p_owner) on conflict do nothing;
  select * into w from companion_private.wallets where owner_id = p_owner for update;
  select * into p from companion_private.wallet_policy;
  if p.enabled and p.welcome_credits > 0
    and companion_private.wallet_book(p_owner, 'GRANT', p.welcome_version, p.welcome_credits, 0, null, null, null, 'welcome gift') then
    select * into w from companion_private.wallets where owner_id = p_owner;
  end if;
  return w;
end $$;

-- Whether the Owner can pay for a call of this cost: null (yes, or the wallet is off), 'WALLET'
-- (too few credits) or 'FROZEN'. Locks the wallet, so the hold that follows cannot be overtaken.
create function companion_private.wallet_check(p_owner uuid, p_cost_minor bigint, p_background boolean)
returns text language plpgsql security definer set search_path='' as $$
declare p companion_private.wallet_policy%rowtype; w companion_private.wallets%rowtype;
begin
  select * into p from companion_private.wallet_policy;
  if not p.enabled then return null; end if;
  w := companion_private.wallet_for(p_owner);
  if w.state = 'FROZEN' then return 'FROZEN'; end if;
  if w.free_credits + w.paid_credits < p_cost_minor * p.credits_per_cent + (case when p_background then p.background_floor else 0 end) then
    return 'WALLET';
  end if;
  return null;
end $$;

-- Holds the credits for a booked call (after wallet_check said yes), free credits first.
create function companion_private.wallet_hold(p_owner uuid, p_companion uuid, p_tx uuid, p_cost_minor bigint, p_purpose text)
returns void language plpgsql security definer set search_path='' as $$
declare p companion_private.wallet_policy%rowtype; w companion_private.wallets%rowtype; need bigint; v_free bigint;
begin
  select * into p from companion_private.wallet_policy;
  if not p.enabled then return; end if;
  select * into w from companion_private.wallets where owner_id = p_owner for update;
  need := p_cost_minor * p.credits_per_cent;
  v_free := least(need, w.free_credits);
  perform companion_private.wallet_book(p_owner, 'HOLD', p_tx::text, -v_free, -(need - v_free), p_purpose, p_companion,
    companion_private.wallet_price_version(p.credits_per_cent));
  insert into companion_private.wallet_holds(compute_tx, owner_id, free_held, paid_held, credits_per_cent, purpose, companion_id)
    values (p_tx, p_owner, v_free, need - v_free, p.credits_per_cent, p_purpose, p_companion);
end $$;

-- Ends a call's hold: charges p_cost_minor at the price of the hold (null: charge nothing) and
-- gives the rest back, paid credits first. No hold: nothing to do.
create function companion_private.wallet_close(p_tx uuid, p_cost_minor bigint)
returns void language plpgsql security definer set search_path='' as $$
declare h companion_private.wallet_holds%rowtype; back bigint; back_paid bigint;
begin
  select * into h from companion_private.wallet_holds where compute_tx = p_tx;
  if not found then return; end if;
  perform 1 from companion_private.wallets where owner_id = h.owner_id for update;
  select * into h from companion_private.wallet_holds where compute_tx = p_tx for update;
  if not found then return; end if;
  back := greatest(0, h.free_held + h.paid_held - coalesce(p_cost_minor, 0) * h.credits_per_cent);
  back_paid := least(back, h.paid_held);
  perform companion_private.wallet_book(h.owner_id, 'RELEASE', p_tx::text, back - back_paid, back_paid, h.purpose, h.companion_id,
    companion_private.wallet_price_version(h.credits_per_cent));
  delete from companion_private.wallet_holds where compute_tx = p_tx;
end $$;

-- ---------- one booking path for chat and diary ----------

-- Checks and books one platform model call for the Owner's Companion, starts it and holds the
-- credits. Returns {"decision": "RESERVED", "transactionId"}, {"decision": "DISABLED"} (a model
-- switch), {"decision": "DISABLED", "reason": "PLATFORM_LIMIT"} or {"decision": "QUOTA", "reason"} (WALLET, FROZEN, NO_BUDGET, or
-- the ledger's own reason). Nothing is booked unless RESERVED.
create function companion_private.compute_book(p_owner uuid, p_companion uuid, p_reason text, p_event_type text, p_event uuid,
  p_purpose text, p_background boolean, p_provider text, p_model text, p_pricing_version text,
  p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_prompt_version text, p_memory_version text,
  p_router_version text, p_trace text, p_attempt integer, p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q companion_private.chat_quota%rowtype; cap companion_private.platform_spend_cap%rowtype; r record; v_wallet text;
  day timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if not companion_private.model_enabled(p_provider, p_model) then
    return jsonb_build_object('decision', 'DISABLED');
  end if;
  -- Locked, so two calls cannot both fit under the cap with room for one.
  select * into cap from companion_private.platform_spend_cap for update;
  if cap.enabled and companion_private.platform_spent_today() + p_cost_minor > cap.daily_cost_minor then
    return jsonb_build_object('decision', 'DISABLED', 'reason', 'PLATFORM_LIMIT');
  end if;
  v_wallet := companion_private.wallet_check(p_owner, p_cost_minor, p_background);
  if v_wallet is not null then return jsonb_build_object('decision', 'QUOTA', 'reason', v_wallet); end if;
  select * into q from companion_private.chat_quota;
  -- Today's free budget (the UTC day), created on first use. If another budget already covers part
  -- of today, none is created and the reservation below finds no budget: QUOTA.
  insert into public.compute_budgets(owner_id, companion_id, period_start, period_end, max_model_calls,
      max_input_tokens, max_output_tokens, max_cost_minor, currency)
    select p_owner, p_companion, day, day + interval '1 day', q.daily_calls, q.daily_calls::bigint * 16000,
      q.daily_calls::bigint * 2000, q.daily_cost_minor, q.currency
    where not exists(select 1 from public.compute_budgets b where b.owner_id = p_owner and b.companion_id = p_companion
      and b.period_start <= now() and now() < b.period_end)
    on conflict do nothing;
  begin
    select * into r from companion_private.reserve_compute_transaction(p_owner, p_companion, null,
      p_reason, p_event_type, p_event, p_provider, null, p_model, p_model, 'OWNER', q.currency, p_pricing_version,
      p_input_tokens, p_output_tokens, p_cost_minor,
      p_prompt_version, (select i.version from public.companions x join public.companion_identities i on i.id = x.current_identity_version_id
        where x.id = p_companion), null, p_memory_version, 'encounter-safety/0.1.0', p_router_version,
      p_trace, p_attempt, null, p_key,
      encode(sha256(convert_to(concat_ws(':', p_key, p_provider, p_model, p_input_tokens, p_output_tokens, p_cost_minor),'UTF8')), 'hex'));
  exception when sqlstate 'P0001' then -- no budget covers now
    return jsonb_build_object('decision', 'QUOTA', 'reason', 'NO_BUDGET');
  end;
  if r.decision <> 'RESERVED' then return jsonb_build_object('decision', 'QUOTA', 'reason', r.outcome_code); end if;
  perform companion_private.start_compute_transaction(p_owner, r.transaction_id);
  perform companion_private.wallet_hold(p_owner, p_companion, r.transaction_id, p_cost_minor, p_purpose);
  return jsonb_build_object('decision', 'RESERVED', 'transactionId', r.transaction_id);
end $$;

-- Same as in 0041, through compute_book.
create or replace function public.chat_reserve(p_reply uuid, p_claim uuid, p_purpose text, p_provider text, p_model text,
  p_pricing_version text, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_trace text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c companion_private.chats%rowtype; m companion_private.chat_messages%rowtype; v_chat uuid; result jsonb;
begin
  if p_purpose is null or p_purpose not in ('REPLY', 'DECIDE') then
    raise exception using errcode='22023', message='invalid purpose';
  end if;
  select chat_id into v_chat from companion_private.chat_messages where id = p_reply;
  select * into c from companion_private.chats where id = v_chat and owner_id = companion_private.chat_owner() for update;
  if not found then return jsonb_build_object('decision', 'STALE'); end if;
  select * into m from companion_private.chat_messages where id = p_reply;
  if m.status <> 'PENDING' or m.claim_id is distinct from p_claim then return jsonb_build_object('decision', 'STALE'); end if;
  result := companion_private.compute_book(c.owner_id, m.companion_id,
    case p_purpose when 'REPLY' then 'OWNER_DIRECT_RESPONSE' else 'CHAT_TURN_DECISION' end, 'CHAT_MESSAGE', m.id, 'CHAT', false,
    p_provider, p_model, p_pricing_version, p_input_tokens, p_output_tokens, p_cost_minor, 'chat/1', 'chat-history/1', 'chat-router/1',
    p_trace, m.attempts, encode(sha256(convert_to(m.claim_id::text || ':' || p_purpose,'UTF8')), 'hex'));
  if result->>'decision' = 'RESERVED' then
    update companion_private.chat_messages set compute_tx = (result->>'transactionId')::uuid where id = m.id;
  end if;
  return result;
end $$;

-- Same as in 0045, through compute_book; a diary entry is background work.
create or replace function public.diary_reserve(p_entry uuid, p_claim uuid, p_provider text, p_model text,
  p_pricing_version text, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_trace text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e companion_private.diary_entries%rowtype; result jsonb;
begin
  e := companion_private.diary_entry_for(p_entry);
  if e.id is null or e.status <> 'WRITING' or e.claim_id is distinct from p_claim then
    return jsonb_build_object('decision', 'STALE');
  end if;
  result := companion_private.compute_book(companion_private.chat_owner(), e.companion_id, 'DIARY_ENTRY', 'DIARY_ENTRY', e.id,
    'DIARY', true, p_provider, p_model, p_pricing_version, p_input_tokens, p_output_tokens, p_cost_minor,
    'diary/1', 'diary-material/1', 'diary/1', p_trace, 1, encode(sha256(convert_to(e.claim_id::text || ':DIARY','UTF8')), 'hex'));
  if result->>'decision' = 'RESERVED' then
    update companion_private.diary_entries set compute_tx = (result->>'transactionId')::uuid where id = e.id;
  end if;
  return result;
end $$;

-- Same as in 0045, plus: the call's credits are charged (only when it succeeded) and the rest released.
create or replace function public.chat_settle(p_transaction uuid, p_input_tokens bigint, p_output_tokens bigint, p_cost_minor bigint, p_ok boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner();
begin
  perform 1 from public.compute_transactions where id = p_transaction and owner_id = o
    and trigger_event_type in ('CHAT_MESSAGE', 'DIARY_ENTRY') for update;
  if not found then raise exception using errcode='P0001', message='chat compute transaction not found'; end if;
  if (select status from public.compute_ledger_entries where transaction_id = p_transaction order by sequence desc limit 1) <> 'STARTED' then
    return jsonb_build_object('settled', false);
  end if;
  perform companion_private.settle_compute_transaction(o, p_transaction, p_input_tokens, p_output_tokens, p_cost_minor,
    case when p_ok then 'SUCCEEDED' else 'FAILED' end, case when p_ok then null else 'PROVIDER_ERROR' end, null);
  perform companion_private.wallet_close(p_transaction, case when p_ok then p_cost_minor end);
  return jsonb_build_object('settled', true);
end $$;

-- Same as in 0041, plus: an abandoned call's credits all go back (the outcome is unknown).
create or replace function companion_private.chat_abandon_compute(p_owner uuid, p_tx uuid)
returns void language plpgsql security definer set search_path='' as $$
declare t public.compute_transactions%rowtype; latest text;
begin
  select * into t from public.compute_transactions where id = p_tx and owner_id = p_owner for update;
  if not found then return; end if;
  select status into latest from public.compute_ledger_entries where transaction_id = p_tx order by sequence desc limit 1;
  if latest = 'STARTED' then
    perform companion_private.settle_compute_transaction(p_owner, p_tx, t.estimated_input_tokens, t.max_output_tokens,
      t.reserved_cost_minor, 'FAILED', 'CHAT_ABANDONED', null);
  elsif latest = 'RESERVED' then
    perform companion_private.release_compute_transaction(p_owner, p_tx, 'CHAT_ABANDONED');
  end if;
  perform companion_private.wallet_close(p_tx, null);
end $$;

-- ---------- for the Owner ----------

-- GET /v0/wallet. While the wallet is off: enabled false and nothing else is created.
create function public.wallet_get()
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid := companion_private.chat_owner(); p companion_private.wallet_policy%rowtype; w companion_private.wallets%rowtype;
  held bigint;
begin
  if o is null then raise exception using errcode='42501', message='active Owner authentication is required'; end if;
  select * into p from companion_private.wallet_policy;
  if not p.enabled then return jsonb_build_object('enabled', false); end if;
  w := companion_private.wallet_for(o);
  select coalesce(sum(free_held + paid_held), 0) into held from companion_private.wallet_holds where owner_id = o;
  return jsonb_build_object('enabled', true, 'state', w.state, 'available', w.free_credits + w.paid_credits,
    'freeCredits', w.free_credits, 'paidCredits', w.paid_credits, 'reserved', held,
    'creditsPerCent', p.credits_per_cent, 'priceVersion', companion_private.wallet_price_version(p.credits_per_cent),
    'version', w.version);
end $$;

-- ---------- for the operators (admin console) ----------

create function companion_admin.spend_cap_set(p_enabled boolean, p_daily_cost_minor bigint, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare c companion_private.platform_spend_cap%rowtype;
begin
  select * into c from companion_private.platform_spend_cap for update;
  update companion_private.platform_spend_cap set enabled = p_enabled, daily_cost_minor = p_daily_cost_minor, updated_at = now();
  perform companion_private.admin_note('SPEND_CAP', 'SPEND_CAP', 'daily', null, p_reason, jsonb_build_object(
    'enabled', p_enabled, 'dailyCostMinor', p_daily_cost_minor,
    'before', jsonb_build_object('enabled', c.enabled, 'dailyCostMinor', c.daily_cost_minor)));
end $$;

create function companion_admin.wallet_policy_set(p_enabled boolean, p_welcome_credits bigint, p_credits_per_cent integer,
  p_background_floor bigint, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare p companion_private.wallet_policy%rowtype;
begin
  select * into p from companion_private.wallet_policy for update;
  update companion_private.wallet_policy set enabled = p_enabled, welcome_credits = p_welcome_credits,
    credits_per_cent = p_credits_per_cent, background_floor = p_background_floor, updated_at = now();
  perform companion_private.admin_note('WALLET_POLICY', 'WALLET_POLICY', 'policy', null, p_reason, jsonb_build_object(
    'enabled', p_enabled, 'welcomeCredits', p_welcome_credits, 'creditsPerCent', p_credits_per_cent,
    'backgroundFloor', p_background_floor, 'before', jsonb_build_object('enabled', p.enabled,
      'welcomeCredits', p.welcome_credits, 'creditsPerCent', p.credits_per_cent, 'backgroundFloor', p.background_floor)));
end $$;

-- Adds free credits to an Owner (negative: takes them, down to 0 at most). Each call books once.
create function companion_admin.wallet_adjust(p_owner uuid, p_credits bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w companion_private.wallets%rowtype; v_delta bigint; v_reason text := companion_private.admin_reason(p_reason);
begin
  if p_credits is null or p_credits = 0 or abs(p_credits) > 100000000 then
    raise exception using errcode='22023', message='credits must be a non-zero whole number';
  end if;
  if not exists(select 1 from public.owners where id = p_owner) then
    raise exception using errcode='P0001', message='owner not found';
  end if;
  w := companion_private.wallet_for(p_owner);
  v_delta := greatest(p_credits, -w.free_credits);
  perform companion_private.wallet_book(p_owner, 'ADJUST', gen_random_uuid()::text, v_delta, 0, null, null, null, v_reason);
  perform companion_private.admin_note('WALLET_ADJUST', 'OWNER', p_owner::text, p_owner, v_reason,
    jsonb_build_object('credits', v_delta, 'before', w.free_credits));
  return jsonb_build_object('freeCredits', w.free_credits + v_delta, 'paidCredits', w.paid_credits);
end $$;

-- The model switches, the free daily budget per Companion, the platform cap with today's spend,
-- and the wallet policy.
create or replace function companion_admin.models()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'switches', coalesce((select jsonb_agg(jsonb_build_object('scope', s.scope, 'key', s.key, 'enabled', s.enabled,
        'note', s.note, 'updatedAt', s.updated_at) order by s.scope, s.key) from companion_private.model_switches s), '[]'),
    'quota', (select jsonb_build_object('dailyCalls', q.daily_calls, 'dailyCostMinor', q.daily_cost_minor,
        'currency', q.currency, 'updatedAt', q.updated_at) from companion_private.chat_quota q),
    'cap', (select jsonb_build_object('enabled', c.enabled, 'dailyCostMinor', c.daily_cost_minor, 'currency', c.currency,
        'spentTodayMinor', companion_private.platform_spent_today(), 'updatedAt', c.updated_at) from companion_private.platform_spend_cap c),
    'wallet', (select jsonb_build_object('enabled', p.enabled, 'welcomeCredits', p.welcome_credits,
        'creditsPerCent', p.credits_per_cent, 'backgroundFloor', p.background_floor, 'updatedAt', p.updated_at)
      from companion_private.wallet_policy p))
$$;

revoke all on function companion_private.platform_spent_today(), companion_private.wallet_price_version(integer),
  companion_private.wallet_book(uuid, text, text, bigint, bigint, text, uuid, text, text), companion_private.wallet_for(uuid),
  companion_private.wallet_check(uuid, bigint, boolean), companion_private.wallet_hold(uuid, uuid, uuid, bigint, text),
  companion_private.wallet_close(uuid, bigint),
  companion_private.compute_book(uuid, uuid, text, text, uuid, text, boolean, text, text, text, bigint, bigint, bigint, text, text, text, text, integer, text),
  public.wallet_get(),
  companion_admin.spend_cap_set(boolean, bigint, text), companion_admin.wallet_policy_set(boolean, bigint, integer, bigint, text),
  companion_admin.wallet_adjust(uuid, bigint, text)
  from public, anon, authenticated;
grant execute on function public.wallet_get() to authenticated;
grant execute on function companion_admin.spend_cap_set(boolean, bigint, text),
  companion_admin.wallet_policy_set(boolean, bigint, integer, bigint, text), companion_admin.wallet_adjust(uuid, bigint, text)
  to companion_admin;

commit;
