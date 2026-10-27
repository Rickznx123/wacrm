-- ============================================================
-- 046_conversations_default_pending.sql
--
-- New conversations start in the waiting queue ("Em espera").
-- Moving to 'open' ("Em atendimento") is an explicit agent action
-- that also sets assigned_agent_id, so no insert path may rely on
-- the old 'open' default.
-- ============================================================

ALTER TABLE conversations
  ALTER COLUMN status SET DEFAULT 'pending';
