-- When the Owner wallet is on, a Companion's free daily budget no longer stops it: the Owner pays
-- in credits, and the platform daily spend cap still bounds the total. While the wallet is off,
-- the free daily budget (companion_admin.chat_quota_set) works as before.
--
-- How: compute_book (0051) still books every call against a budget for today (the ledger needs
-- one); while the wallet is on, that budget's limits are raised out of reach. Turning the wallet
-- off again leaves today's raised budget as it is; tomorrow's is made with the free limits.

create or replace function companion_private.compute_book(p_owner uuid, p_companion uuid, p_reason text, p_event_type text, p_event uuid,
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
  -- While the wallet is on, the Owner pays in credits: today's budget does not stop the Companion,
  -- also when it was made under the free limits before the wallet was turned on today.
  if (select enabled from companion_private.wallet_policy) then
    update public.compute_budgets set max_model_calls = 1000000, max_input_tokens = 1000000000000,
        max_output_tokens = 1000000000000, max_cost_minor = 100000000
      where owner_id = p_owner and companion_id = p_companion and period_start <= now() and now() < period_end
        and max_model_calls < 1000000;
  end if;
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
