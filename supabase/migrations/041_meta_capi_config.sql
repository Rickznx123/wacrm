-- ============================================================
-- 041_meta_capi_config.sql
--
-- Account-scoped Meta Conversions API configuration.
-- RLS mirrors whatsapp_channels: members can read, only admin can write.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_capi_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dataset_id      text,
  access_token    text,
  enabled         boolean NOT NULL DEFAULT false,
  test_event_code text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_capi_config_account
  ON meta_capi_config(account_id);

ALTER TABLE meta_capi_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_capi_config_select ON meta_capi_config;
CREATE POLICY meta_capi_config_select ON meta_capi_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS meta_capi_config_insert ON meta_capi_config;
CREATE POLICY meta_capi_config_insert ON meta_capi_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_capi_config_update ON meta_capi_config;
CREATE POLICY meta_capi_config_update ON meta_capi_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_capi_config_delete ON meta_capi_config;
CREATE POLICY meta_capi_config_delete ON meta_capi_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON meta_capi_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meta_capi_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
