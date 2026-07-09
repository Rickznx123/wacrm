-- ============================================================
-- Evolution webhook consistency: atomic message persistence
--
-- Ensures inbound message insert + conversation unread/last_message
-- update happen atomically so partial failures cannot leave the
-- conversation in an inconsistent state.
--
-- Idempotent replay behavior:
--   - Duplicate (conversation_id, message_id) returns false.
--   - Conversation counters/text are NOT touched on duplicates.
-- ============================================================

CREATE OR REPLACE FUNCTION public.persist_inbound_message_and_touch_conversation(
  p_conversation_id UUID,
  p_message_id TEXT,
  p_content_type TEXT,
  p_content_text TEXT,
  p_media_url TEXT,
  p_created_at TIMESTAMPTZ,
  p_last_message_text TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INTEGER := 0;
BEGIN
  INSERT INTO messages (
    conversation_id,
    sender_type,
    content_type,
    content_text,
    media_url,
    message_id,
    status,
    created_at
  )
  VALUES (
    p_conversation_id,
    'customer',
    p_content_type,
    p_content_text,
    p_media_url,
    p_message_id,
    'delivered',
    p_created_at
  )
  ON CONFLICT (conversation_id, message_id)
  WHERE message_id IS NOT NULL
  DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE conversations
  SET
    last_message_text = p_last_message_text,
    last_message_at = NOW(),
    unread_count = COALESCE(unread_count, 0) + 1,
    updated_at = NOW()
  WHERE id = p_conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found: %', p_conversation_id
      USING ERRCODE = '22023';
  END IF;

  RETURN TRUE;
END;
$$;

ALTER FUNCTION public.persist_inbound_message_and_touch_conversation(
  UUID,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TIMESTAMPTZ,
  TEXT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.persist_inbound_message_and_touch_conversation(
  UUID,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TIMESTAMPTZ,
  TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.persist_inbound_message_and_touch_conversation(
  UUID,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TIMESTAMPTZ,
  TEXT
) TO service_role;
