-- ============================================================
-- 040_whatsapp_media_storage.sql
--
-- Bucket used by Evolution inbound webhook media hydration:
-- webhook -> Evolution getBase64FromMediaMessage -> Storage upload
--
-- NOTE:
-- This bucket is intentionally PUBLIC for this first implementation
-- so webhook processing can persist a stable media_url without
-- frontend signed-url refresh logic.
-- Trade-off: easier implementation now, weaker privacy posture.
-- Next phase can migrate to private bucket + signed URLs on read.
--
-- Path convention:
--   whatsapp-media/account-<account_id>/<message_id>.<ext>
--
-- Public read so inbox can render media_url directly.
-- Writes are performed by service-role from server route handlers.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-media',
  'whatsapp-media',
  TRUE,
  33554432,
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/3gpp',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr',
    'application/pdf',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "WhatsApp media is publicly readable" ON storage.objects;
CREATE POLICY "WhatsApp media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'whatsapp-media');
