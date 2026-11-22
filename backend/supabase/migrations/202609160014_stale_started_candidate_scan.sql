begin;

create or replace function companion_private.list_stale_started_encounter_candidates(
  p_cutoff timestamptz,
  p_after_stale_at timestamptz,
  p_after_execution_claim_id uuid,
  p_limit integer
)
returns table (
  execution_claim_id uuid,
  actor_owner_id uuid,
  encounter_id uuid,
  started_at timestamptz,
  stale_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select claim.id, claim.actor_owner_id, claim.encounter_id, provider_start.created_at,
    least(provider_start.created_at + interval '15 minutes', invitation.expires_at)
  from companion_private.encounter_execution_claims as claim
  join public.encounter_invitations as invitation
    on invitation.id = claim.invitation_id
   and invitation.initiator_owner_id = claim.actor_owner_id
   and invitation.claimed_at = claim.claimed_at
   and invitation.used_at is null
  join lateral (
    select entry.created_at
    from public.compute_ledger_entries as entry
    where entry.transaction_id = claim.generation_transaction_id
      and entry.entry_type = 'START'
      and entry.status = 'STARTED'
    order by entry.sequence asc
    limit 1
  ) as provider_start on true
  join lateral (
    select entry.entry_type, entry.status
    from public.compute_ledger_entries as entry
    where entry.transaction_id = claim.generation_transaction_id
    order by entry.sequence desc
    limit 1
  ) as latest_compute on latest_compute.entry_type = 'START'
    and latest_compute.status = 'STARTED'
  where p_cutoff is not null
    and p_limit between 1 and 100
    and least(provider_start.created_at + interval '15 minutes', invitation.expires_at) <= p_cutoff
    and not exists (
      select 1 from companion_private.encounter_idempotency as terminal
      where terminal.execution_claim_id = claim.id
    )
    and (
      p_after_stale_at is null
      or (least(provider_start.created_at + interval '15 minutes', invitation.expires_at), claim.id)
         > (p_after_stale_at, p_after_execution_claim_id)
    )
  order by least(provider_start.created_at + interval '15 minutes', invitation.expires_at), claim.id
  limit p_limit;
$$;

revoke all on function companion_private.list_stale_started_encounter_candidates(
  timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function companion_private.list_stale_started_encounter_candidates(
  timestamptz, timestamptz, uuid, integer
) to service_role;

comment on function companion_private.list_stale_started_encounter_candidates(timestamptz, timestamptz, uuid, integer)
is 'Lists bounded stale START candidates for server orchestration; reconciliation revalidates eligibility under row locks.';

commit;
