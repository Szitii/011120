begin;

revoke all on schema companion_private from public, anon, authenticated;

alter table public.social_personas add column source_identity_version integer;
update public.social_personas as persona
set source_identity_version = identity.version
from public.companion_identities as identity
where identity.id = persona.source_identity_version_id;
alter table public.social_personas alter column source_identity_version set not null;
alter table public.social_personas add constraint social_personas_source_identity_version_positive
check (source_identity_version > 0);

alter table companion_private.memory_permissions
drop constraint memory_permissions_purpose_check;
alter table companion_private.memory_permissions
add constraint memory_permissions_purpose_check
check (purpose in ('PRIVATE_CHAT', 'SOCIAL_POST', 'SOCIAL_ENCOUNTER', 'COMMENT_REPLY', 'DM', 'PROFILE', 'LIFE_EVENT', 'EXPORT'));

create table public.encounter_invitations (
  id uuid primary key default gen_random_uuid(),
  initiator_owner_id uuid not null references public.owners(id) on delete cascade,
  initiator_twin_id uuid not null,
  responder_owner_id uuid not null references public.owners(id) on delete cascade,
  responder_twin_id uuid not null,
  approved_by_owner_ids uuid[] not null,
  purpose text not null check (char_length(purpose) between 1 and 500),
  friendship_id uuid,
  max_uses integer not null default 1 check (max_uses = 1),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check (initiator_owner_id <> responder_owner_id),
  check (initiator_twin_id <> responder_twin_id),
  check (approved_by_owner_ids @> array[initiator_owner_id, responder_owner_id]),
  check (expires_at > created_at),
  foreign key (initiator_twin_id, initiator_owner_id) references public.social_twins(id, owner_id),
  foreign key (responder_twin_id, responder_owner_id) references public.social_twins(id, owner_id)
);

create table public.encounter_artifacts (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.encounter_invitations(id),
  initiator_owner_id uuid not null references public.owners(id) on delete cascade,
  initiator_twin_id uuid not null,
  responder_owner_id uuid not null references public.owners(id) on delete cascade,
  responder_twin_id uuid not null,
  body text not null check (char_length(body) between 1 and 2000),
  status text not null check (status in ('DELIVERED', 'REDACTED')),
  generation_transaction_id uuid not null references public.compute_transactions(id),
  safety_event_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (initiator_twin_id, initiator_owner_id) references public.social_twins(id, owner_id),
  foreign key (responder_twin_id, responder_owner_id) references public.social_twins(id, owner_id)
);

create table companion_private.encounter_safety_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  social_twin_id uuid not null,
  direction text not null check (direction in ('INPUT', 'OUTPUT')),
  surface text not null check (surface = 'ENCOUNTER'),
  threat_types text[] not null,
  decision text not null check (decision in ('ALLOW', 'REDACT', 'BLOCK', 'LIMIT')),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  redaction_count integer not null check (redaction_count >= 0),
  policy_version text not null,
  related_encounter_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  foreign key (social_twin_id, owner_id) references public.social_twins(id, owner_id)
);

alter table public.encounter_artifacts
add constraint encounter_artifacts_safety_event_fk
foreign key (safety_event_id) references companion_private.encounter_safety_events(id);

create table public.life_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  kind text not null check (kind = 'SOCIAL_ENCOUNTER'),
  title text not null check (char_length(title) between 1 and 200),
  structured_state jsonb not null check (jsonb_typeof(structured_state) = 'object'),
  source text not null check (source = 'SOCIAL'),
  visibility_domain text not null check (visibility_domain = 'OWNER_ONLY'),
  occurred_at timestamptz not null,
  requires_personality_decision boolean not null default false check (not requires_personality_decision),
  decision_transaction_id uuid not null references public.compute_transactions(id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key),
  unique (id, owner_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id)
);

create table public.life_event_inbox (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  companion_id uuid not null,
  life_event_id uuid not null,
  title text not null check (char_length(title) between 1 and 200),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (life_event_id),
  foreign key (companion_id, owner_id) references public.companions(id, owner_id),
  foreign key (life_event_id, owner_id) references public.life_events(id, owner_id)
);

create table companion_private.encounter_idempotency (
  owner_id uuid not null references public.owners(id) on delete cascade,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  encounter_id uuid not null,
  result_status text not null check (result_status in ('DELIVERED', 'REDACTED', 'BLOCKED', 'FAILED')),
  created_at timestamptz not null default now(),
  primary key (owner_id, idempotency_key_hash)
);

create or replace function companion_private.allow_invitation_consume_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    or old.used_at is not null
    or new.used_at is null
    or (to_jsonb(new) - 'used_at') <> (to_jsonb(old) - 'used_at') then
    raise exception 'encounter invitations may only transition used_at from null once';
  end if;
  return new;
end;
$$;

create trigger encounter_invitations_consume_only
before update or delete on public.encounter_invitations
for each row execute function companion_private.allow_invitation_consume_only();

create trigger encounter_artifacts_immutable
before update or delete on public.encounter_artifacts
for each row execute function companion_private.reject_immutable_mutation();

create trigger encounter_safety_events_immutable
before update or delete on companion_private.encounter_safety_events
for each row execute function companion_private.reject_immutable_mutation();

create trigger life_events_immutable
before update or delete on public.life_events
for each row execute function companion_private.reject_immutable_mutation();

alter table public.encounter_invitations enable row level security;
alter table public.encounter_invitations force row level security;
alter table public.encounter_artifacts enable row level security;
alter table public.encounter_artifacts force row level security;
alter table public.life_events enable row level security;
alter table public.life_events force row level security;
alter table public.life_event_inbox enable row level security;
alter table public.life_event_inbox force row level security;

create policy encounter_invitations_select_participant on public.encounter_invitations
for select to authenticated using (
  exists (
    select 1 from public.owners
    where owners.auth_user_id = (select auth.uid())
      and owners.id in (encounter_invitations.initiator_owner_id, encounter_invitations.responder_owner_id)
  )
);

create policy encounter_artifacts_select_participant on public.encounter_artifacts
for select to authenticated using (
  exists (
    select 1 from public.owners
    where owners.auth_user_id = (select auth.uid())
      and owners.id in (encounter_artifacts.initiator_owner_id, encounter_artifacts.responder_owner_id)
  )
);

create policy life_events_select_owned on public.life_events
for select to authenticated using (
  exists (select 1 from public.owners where owners.id = life_events.owner_id and owners.auth_user_id = (select auth.uid()))
);

create policy life_event_inbox_select_owned on public.life_event_inbox
for select to authenticated using (
  exists (select 1 from public.owners where owners.id = life_event_inbox.owner_id and owners.auth_user_id = (select auth.uid()))
);

revoke insert, update, delete on public.encounter_invitations from anon, authenticated;
revoke insert, update, delete on public.encounter_artifacts from anon, authenticated;
revoke insert, update, delete on public.life_events from anon, authenticated;
revoke insert, update, delete on public.life_event_inbox from anon, authenticated;

comment on table public.encounter_invitations is 'Mutually Owner-approved, expiring, one-shot Encounter capability.';
comment on table public.encounter_artifacts is 'DLP-cleared bounded Encounter output; blocked output is never persisted here.';
comment on table companion_private.encounter_safety_events is 'Hash-only safety evidence. Raw blocked input/output is prohibited.';
comment on table public.life_events is 'Owner-only event evidence; never automatically promoted to Memory or Post.';
comment on table public.life_event_inbox is 'Owner-scoped review surface for durable Life Events.';

commit;
