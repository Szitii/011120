begin;

create or replace function companion_private.record_encounter_safety_event(
  p_id uuid, p_owner_id uuid, p_companion_id uuid, p_social_twin_id uuid,
  p_direction text, p_decision text, p_threat_types text[], p_content_hash text,
  p_sanitized_content_hash text, p_redaction_count integer, p_policy_version text,
  p_encounter_id uuid
) returns table (safety_event_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if p_direction not in ('INPUT','OUTPUT') or p_decision not in ('ALLOW','LIMIT','REDACT','BLOCK')
    or p_content_hash !~ '^[a-f0-9]{64}$' or p_redaction_count < 0
    or p_policy_version is null or btrim(p_policy_version) = '' then
    raise exception using errcode='22023', message='invalid Encounter safety evidence';
  end if;
  if not exists(select 1 from public.social_twins where id=p_social_twin_id and owner_id=p_owner_id and companion_id=p_companion_id and status='ACTIVE') then
    raise exception using errcode='42501', message='safety evidence principal is outside active Social Twin scope';
  end if;
  insert into companion_private.encounter_safety_events(id,owner_id,companion_id,social_twin_id,direction,surface,threat_types,decision,content_hash,sanitized_content_hash,redaction_count,policy_version,related_encounter_id)
  values(p_id,p_owner_id,p_companion_id,p_social_twin_id,p_direction,'ENCOUNTER',coalesce(p_threat_types,'{}'),p_decision,p_content_hash,p_sanitized_content_hash,p_redaction_count,p_policy_version,p_encounter_id)
  on conflict(id) do nothing;
  if not exists(select 1 from companion_private.encounter_safety_events where id=p_id and owner_id=p_owner_id and companion_id=p_companion_id and social_twin_id=p_social_twin_id and direction=p_direction and decision=p_decision and content_hash=p_content_hash and sanitized_content_hash is not distinct from p_sanitized_content_hash and redaction_count=p_redaction_count and policy_version=p_policy_version and related_encounter_id=p_encounter_id) then
    raise exception using errcode='23505', message='safety evidence replay differs';
  end if;
  return query select p_id;
end; $$;

revoke all on function companion_private.record_encounter_safety_event(uuid,uuid,uuid,uuid,text,text,text[],text,text,integer,text,uuid) from public, anon, authenticated;
grant execute on function companion_private.record_encounter_safety_event(uuid,uuid,uuid,uuid,text,text,text[],text,text,integer,text,uuid) to service_role;
comment on function companion_private.record_encounter_safety_event(uuid,uuid,uuid,uuid,text,text,text[],text,text,integer,text,uuid) is 'Appends hash-only Encounter safety evidence for the typed server orchestration path.';

create or replace function companion_private.get_encounter_terminal_result(
  p_actor_owner_id uuid, p_idempotency_key_hash text, p_request_hash text
) returns table(encounter_id uuid, result_status text, outcome_code text)
language plpgsql stable security definer set search_path = '' as $$
declare existing companion_private.encounter_idempotency%rowtype;
begin
  select * into existing from companion_private.encounter_idempotency
  where owner_id=p_actor_owner_id and idempotency_key_hash=p_idempotency_key_hash;
  if not found then return; end if;
  if existing.request_hash<>p_request_hash then
    raise exception using errcode='23505', message='Encounter idempotency key reused with a different request';
  end if;
  return query select existing.encounter_id, existing.result_status, existing.outcome_code;
end; $$;
revoke all on function companion_private.get_encounter_terminal_result(uuid,text,text) from public, anon, authenticated;
grant execute on function companion_private.get_encounter_terminal_result(uuid,text,text) to service_role;
comment on function companion_private.get_encounter_terminal_result(uuid,text,text) is 'Returns an exact service-only terminal replay without reopening Provider execution.';

commit;
