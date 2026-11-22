begin;

-- Disposable Stage 1 mobile-development fixtures only.
-- Owner A is the mobile viewer; Companion A is SampleCompanion.
-- Companion B is a public Encounter participant used to validate profile navigation.

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b1');

insert into public.owners (id, auth_user_id, display_name, avatar_url) values
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000a1', 'SampleUser', null),
  ('00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000000b1', 'Another Sample User', null);

insert into public.companions (id, owner_id, status, origin_type) values
  ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000001a1', 'ACTIVE', 'IMPORTED_CARD'),
  ('00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000001b1', 'ACTIVE', 'IMPORTED_CARD');

insert into public.companion_identities
  (id, owner_id, companion_id, version, display_name, identity_document, source_manifest, content_hash, created_by, approved_by_owner_at)
values
  ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1', 1, 'SampleCompanion', '{}', '{"fixture":"mobile-dev"}', repeat('a',64), 'IMPORT_FIREWALL', now()),
  ('00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1', 1, 'AnotherSample', '{}', '{"fixture":"mobile-dev"}', repeat('b',64), 'IMPORT_FIREWALL', now());

update public.companions
set current_identity_version_id='00000000-0000-0000-0000-0000000003a1'
where id='00000000-0000-0000-0000-0000000002a1';

update public.companions
set current_identity_version_id='00000000-0000-0000-0000-0000000003b1'
where id='00000000-0000-0000-0000-0000000002b1';

insert into public.social_handles (handle, owner_id, companion_id) values
  ('sample_companion_stage1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1'),
  ('another_sample_stage1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1');

insert into public.social_personas
  (id, owner_id, companion_id, version, handle, display_name, public_document, profile_visibility,
   source_identity_version_id, source_identity_version, source_identity_content_hash, projection_manifest,
   content_hash, approved_by_owner_at)
values
  ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1', 1,
   'sample_companion_stage1', 'SampleCompanion', '{"bio":"Stage 1 device fixture"}', 'PUBLIC',
   '00000000-0000-0000-0000-0000000003a1', 1, repeat('a',64), '[]', repeat('a',64), now()),
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1', 1,
   'another_sample_stage1', 'AnotherSample', '{"bio":"Public Encounter participant fixture"}', 'PUBLIC',
   '00000000-0000-0000-0000-0000000003b1', 1, repeat('b',64), '[]', repeat('b',64), now());

insert into public.social_twins
  (id, owner_id, companion_id, active_social_persona_id, status, autonomy_mode)
values
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000004a1', 'ACTIVE', 'QUIET'),
  ('00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000004b1', 'ACTIVE', 'QUIET');

insert into public.encounter_invitations
  (id, initiator_owner_id, initiator_twin_id, responder_owner_id, responder_twin_id,
   approved_by_owner_ids, purpose, expires_at)
values
  ('00000000-0000-0000-0000-0000000008a1',
   '00000000-0000-0000-0000-0000000001a1',
   '00000000-0000-0000-0000-0000000005a1',
   '00000000-0000-0000-0000-0000000001b1',
   '00000000-0000-0000-0000-0000000005b1',
   array[
     '00000000-0000-0000-0000-0000000001a1'::uuid,
     '00000000-0000-0000-0000-0000000001b1'::uuid
   ],
   'A quiet first meeting',
   now() + interval '7 days');

insert into companion_private.encounter_safety_events
  (id, owner_id, companion_id, social_twin_id, direction, surface, threat_types, decision,
   content_hash, redaction_count, policy_version, related_encounter_id)
values
  ('00000000-0000-0000-0000-0000000007b1',
   '00000000-0000-0000-0000-0000000001b1',
   '00000000-0000-0000-0000-0000000002b1',
   '00000000-0000-0000-0000-0000000005b1',
   'INPUT', 'ENCOUNTER', '{}', 'BLOCK',
   repeat('d',64), 0, 'safety/1',
   '00000000-0000-4000-8000-000000000901');

insert into companion_private.encounter_idempotency
  (owner_id, idempotency_key_hash, request_hash, encounter_id, result_status,
   invitation_id, safety_event_id, outcome_code)
values
  ('00000000-0000-0000-0000-0000000001a1',
   repeat('1',64),
   repeat('2',64),
   '00000000-0000-4000-8000-000000000901',
   'BLOCKED',
   '00000000-0000-0000-0000-0000000008a1',
   '00000000-0000-0000-0000-0000000007b1',
   'INPUT_SAFETY_BLOCK');


insert into public.social_feed_items
  (id,kind,author_social_twin_id,author_social_persona_id,published_at,body,source_type,source_id,visibility,status)
values
  ('00000000-0000-0000-0000-0000000009f1','ENCOUNTER_EXCERPT',
   '00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000004b1',
   now(),'A quiet first meeting','ENCOUNTER','00000000-0000-4000-8000-000000000901','PUBLIC','PUBLISHED');

commit;
