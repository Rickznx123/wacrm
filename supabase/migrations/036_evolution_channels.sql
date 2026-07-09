-- ============================================================
-- 036_evolution_channels.sql
--
-- Additive module for WhatsApp connections via Evolution API v2.
-- Does NOT replace Meta Cloud API integration (`whatsapp_config`).
--
-- Stores one Evolution channel per account, with QR/state metadata.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'evolution' CHECK (provider IN ('evolution')),
  instance_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('creating', 'qrcode', 'connected', 'disconnected', 'error')),
  phone TEXT,
  profile_name TEXT,
  qr_code TEXT,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_account
  ON whatsapp_channels(account_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_provider_status
  ON whatsapp_channels(provider, status);

ALTER TABLE whatsapp_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_channels_select ON whatsapp_channels;
CREATE POLICY whatsapp_channels_select ON whatsapp_channels FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_channels_insert ON whatsapp_channels;
CREATE POLICY whatsapp_channels_insert ON whatsapp_channels FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_channels_update ON whatsapp_channels;
CREATE POLICY whatsapp_channels_update ON whatsapp_channels FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_channels_delete ON whatsapp_channels;
CREATE POLICY whatsapp_channels_delete ON whatsapp_channels FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_channels;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
