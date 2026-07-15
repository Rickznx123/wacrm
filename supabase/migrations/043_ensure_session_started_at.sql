-- ============================================================
-- 043_ensure_session_started_at.sql
--
-- Production hotfix for webhook reopen payload compatibility.
-- Some environments still miss conversations.session_started_at,
-- causing PGRST204/42703 when the Evolution webhook tries to
-- write the logical-session boundary.
--
-- Idempotent and safe even when migration 042 already ran.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS session_started_at timestamptz;
