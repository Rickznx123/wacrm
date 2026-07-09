-- ============================================================
-- Evolution inbound message deduplication hardening
--
-- Guarantees idempotent inserts for webhook re-delivery by enforcing
-- one message row per (conversation_id, official message_id).
--
-- Safe to run multiple times.
-- ============================================================

-- Keep only the first row for each duplicated (conversation_id, message_id)
-- pair before adding the unique index.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY conversation_id, message_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM messages
  WHERE message_id IS NOT NULL
)
DELETE FROM messages m
USING ranked r
WHERE m.id = r.id
  AND r.rn > 1;

-- Enforce idempotency at the database layer for all inbound providers
-- that persist external message ids.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_message_id_unique
  ON messages (conversation_id, message_id)
  WHERE message_id IS NOT NULL;
