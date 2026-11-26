-- 292_member_ai_thread.sql
--
-- One AI conversation per member. The member app has no thread list, so the
-- server resolves the thread by (organization_id, user_id) and the request
-- carries no id to tamper with. Two first messages arriving together would
-- otherwise create two threads and split the history.
--
-- Partial, because trainers already own conversations in this table and must
-- keep as many as they like. `context` is JSONB added in migration 273.
--
-- Rollback (permits duplicate member threads; loses no data):
--   DROP INDEX IF EXISTS public.ai_conversations_member_ai_thread;

CREATE UNIQUE INDEX IF NOT EXISTS ai_conversations_member_ai_thread
  ON public.ai_conversations (organization_id, user_id)
  WHERE context->>'feature' = 'member_ai';
