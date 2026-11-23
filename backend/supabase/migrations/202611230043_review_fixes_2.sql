begin;

-- Indexes found missing in the 2026-11-23 review.
-- 1. audit_events had no index besides its key, so the daily follow cap (community_write) and the
--    AI's followsToday (agent_settings_json, read on every AI write) scanned the whole table.
-- 2. Unanswered chat turns are looked up on every send, claim, finish and progress poll; a partial
--    index keeps that lookup off the chat's full history.

create index audit_events_actor_action on public.audit_events(actor_id, action, occurred_at);
create index chat_messages_pending on companion_private.chat_messages(chat_id, created_at) where status = 'PENDING';

commit;
