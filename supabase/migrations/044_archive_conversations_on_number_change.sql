-- ============================================================
-- 044_archive_conversations_on_number_change.sql
--
-- When the WhatsApp number linked to an account changes, the
-- conversations of the previous number must leave the inbox:
--   - every conversation is closed and stamped archived_at
--   - the inbox hides archived conversations (all tabs)
--   - if that customer writes again, the normal reopen flow
--     (closed -> pending, new session_started_at) clears archived_at,
--     so the thread comes back empty for the new service cycle.
--
-- whatsapp_channels.phone is nulled while a new QR is pending, so the
-- last linked number is remembered separately in last_line_phone.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS last_line_phone text;

-- Seed with the currently linked number (digits only, JID suffix dropped).
UPDATE whatsapp_channels
SET last_line_phone = regexp_replace(split_part(phone, '@', 1), '\D', '', 'g')
WHERE phone IS NOT NULL AND last_line_phone IS NULL;

CREATE OR REPLACE FUNCTION public.archive_conversations_on_number_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  IF NEW.phone IS NULL THEN
    RETURN NEW;
  END IF;

  v_phone := regexp_replace(split_part(NEW.phone, '@', 1), '\D', '', 'g');
  IF v_phone = '' THEN
    RETURN NEW;
  END IF;

  IF NEW.last_line_phone IS NOT NULL AND NEW.last_line_phone <> v_phone THEN
    UPDATE conversations
    SET status = 'closed',
        archived_at = NOW(),
        updated_at = NOW()
    WHERE account_id = NEW.account_id
      AND archived_at IS NULL;
  END IF;

  NEW.last_line_phone := v_phone;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_archive_conversations_on_number_change ON whatsapp_channels;
CREATE TRIGGER trg_archive_conversations_on_number_change
  BEFORE INSERT OR UPDATE OF phone ON whatsapp_channels
  FOR EACH ROW
  EXECUTE FUNCTION public.archive_conversations_on_number_change();

-- Any reopen (closed -> not closed) brings an archived thread back.
CREATE OR REPLACE FUNCTION public.unarchive_conversation_on_reopen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_unarchive_conversation_on_reopen ON conversations;
CREATE TRIGGER trg_unarchive_conversation_on_reopen
  BEFORE UPDATE OF status ON conversations
  FOR EACH ROW
  WHEN (OLD.archived_at IS NOT NULL)
  EXECUTE FUNCTION public.unarchive_conversation_on_reopen();
