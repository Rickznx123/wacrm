-- ============================================================
-- 045_refill_reminders.sql
--
-- Recompra automática: lembrete por WhatsApp quando um produto de uso
-- contínuo comprado pelo cliente está perto de acabar.
--
--   refill_settings      one row per account; OFF by default
--                        (enabled = sync/schedule, sending_enabled = real sends)
--   refill_products      which products are continuous-use + days per unit
--   refill_purchases     purchases (from PONTE /vendas or manual);
--                        UNIQUE (account, sale, item) makes re-syncs idempotent
--   refill_reminders     one reminder per purchase (UNIQUE purchase_id), with
--                        status history: pending/sending/sent/failed/cancelled
--   refill_contact_preferences
--                        explicit opt-in / opt-out and health-detail consent;
--                        no row = not authorized, nothing is ever sent
--
-- RLS: members read; admins configure; agents manage purchases,
-- reminders and consent. The cron uses the service role.
-- ============================================================

CREATE TABLE IF NOT EXISTS refill_settings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enabled                    boolean NOT NULL DEFAULT false,
  sending_enabled            boolean NOT NULL DEFAULT false,
  default_lead_days          integer NOT NULL DEFAULT 3 CHECK (default_lead_days BETWEEN 0 AND 60),
  message_template           text NOT NULL DEFAULT
    'Olá, {primeiro_nome}! Pela nossa previsão, seu {produto} deve acabar por volta de {data_prevista}. Quer que a gente separe para você? Responda SAIR para não receber mais lembretes.',
  sensitive_message_template text NOT NULL DEFAULT
    'Olá, {primeiro_nome}! Pela nossa previsão, um item da sua última compra deve acabar por volta de {data_prevista}. Quer que a gente separe para você? Responda SAIR para não receber mais lembretes.',
  last_synced_at             timestamptz,
  last_sync_summary          jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id),
  CHECK (char_length(message_template) BETWEEN 1 AND 1000),
  CHECK (char_length(sensitive_message_template) BETWEEN 1 AND 1000)
);

CREATE TABLE IF NOT EXISTS refill_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_product_id text NOT NULL CHECK (char_length(external_product_id) BETWEEN 1 AND 100),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  days_per_unit       integer NOT NULL CHECK (days_per_unit BETWEEN 1 AND 365),
  -- false: the quantity bought doesn't extend the duration (e.g. 2 boxes for 2 people)
  quantity_based      boolean NOT NULL DEFAULT true,
  -- NULL: use refill_settings.default_lead_days
  lead_days           integer CHECK (lead_days BETWEEN 0 AND 60),
  -- true: never name the product in the message without health-detail consent
  sensitive           boolean NOT NULL DEFAULT true,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_product_id)
);

CREATE TABLE IF NOT EXISTS refill_purchases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES refill_products(id) ON DELETE CASCADE,
  source            text NOT NULL CHECK (source IN ('ponte', 'manual')),
  external_sale_id  text NOT NULL,
  external_item_key text NOT NULL,
  quantity          numeric(10,2) NOT NULL CHECK (quantity > 0),
  purchased_at      timestamptz NOT NULL,
  expected_end_at   timestamptz NOT NULL,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_sale_id, external_item_key)
);

CREATE INDEX IF NOT EXISTS idx_refill_purchases_contact_product
  ON refill_purchases(account_id, contact_id, product_id);

CREATE TABLE IF NOT EXISTS refill_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purchase_id     uuid NOT NULL REFERENCES refill_purchases(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES refill_products(id) ON DELETE CASCADE,
  scheduled_for   timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  cancel_reason   text,
  rendered_message text,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      uuid,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- one reminder per purchase: re-running the cron can never create a second one
  UNIQUE (purchase_id)
);

CREATE INDEX IF NOT EXISTS idx_refill_reminders_due
  ON refill_reminders(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_refill_reminders_account
  ON refill_reminders(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refill_contact_preferences (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  opted_in             boolean NOT NULL DEFAULT false,
  opted_in_at          timestamptz,
  opted_in_source      text CHECK (opted_in_source IN ('manual', 'ponte')),
  opted_out_at         timestamptz,
  allow_health_details boolean NOT NULL DEFAULT false,
  updated_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, contact_id)
);

-- ---------- RLS ----------
ALTER TABLE refill_settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE refill_products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE refill_purchases           ENABLE ROW LEVEL SECURITY;
ALTER TABLE refill_reminders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE refill_contact_preferences ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  write_role text;
BEGIN
  FOR t, write_role IN
    SELECT * FROM (VALUES
      ('refill_settings', 'admin'),
      ('refill_products', 'admin'),
      ('refill_purchases', 'agent'),
      ('refill_reminders', 'agent'),
      ('refill_contact_preferences', 'agent')
    ) AS v(t, r)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON %1$s', t);
    EXECUTE format('CREATE POLICY %1$s_select ON %1$s FOR SELECT USING (is_account_member(account_id))', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON %1$s', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON %1$s FOR INSERT WITH CHECK (is_account_member(account_id, %2$L))', t, write_role);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON %1$s', t);
    EXECUTE format('CREATE POLICY %1$s_update ON %1$s FOR UPDATE USING (is_account_member(account_id, %2$L)) WITH CHECK (is_account_member(account_id, %2$L))', t, write_role);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON %1$s', t);
    EXECUTE format('CREATE POLICY %1$s_delete ON %1$s FOR DELETE USING (is_account_member(account_id, ''admin''))', t);
  END LOOP;
END $$;

-- Cross-tenant guard: a purchase/reminder/preference must point at a
-- contact (and product) of the same account, even if a client forges ids.
CREATE OR REPLACE FUNCTION public.refill_check_same_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'contact does not belong to account' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME IN ('refill_purchases', 'refill_reminders')
     AND NOT EXISTS (SELECT 1 FROM refill_products WHERE id = NEW.product_id AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'product does not belong to account' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refill_purchases_same_account ON refill_purchases;
CREATE TRIGGER refill_purchases_same_account BEFORE INSERT OR UPDATE ON refill_purchases
  FOR EACH ROW EXECUTE FUNCTION public.refill_check_same_account();
DROP TRIGGER IF EXISTS refill_reminders_same_account ON refill_reminders;
CREATE TRIGGER refill_reminders_same_account BEFORE INSERT OR UPDATE ON refill_reminders
  FOR EACH ROW EXECUTE FUNCTION public.refill_check_same_account();
DROP TRIGGER IF EXISTS refill_prefs_same_account ON refill_contact_preferences;
CREATE TRIGGER refill_prefs_same_account BEFORE INSERT OR UPDATE ON refill_contact_preferences
  FOR EACH ROW EXECUTE FUNCTION public.refill_check_same_account();

DROP TRIGGER IF EXISTS set_updated_at ON refill_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON refill_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON refill_products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON refill_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON refill_reminders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON refill_reminders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON refill_contact_preferences;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON refill_contact_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
