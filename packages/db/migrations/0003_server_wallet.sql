-- Migration: automatic Server Wallet registration without email
-- Adds three users columns and two platform_config defaults

-- ── wallet_type enum ──────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE wallet_type AS ENUM ('email_wallet', 'server_wallet');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── users：Add Server Wallet fields ────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wallet_type       wallet_type NOT NULL DEFAULT 'email_wallet',
  ADD COLUMN IF NOT EXISTS cdp_account_name  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS wallet_source_ip  VARCHAR(45);

-- ── platform_config：Insert Server Wallet configuration defaults ────────────────────────────
INSERT INTO platform_config (key, value, description)
VALUES
  ('server_wallet_daily_limit', '100', 'Daily automatic Server Wallet registration limit')
  ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_config (key, value, description)
VALUES
  ('server_wallet_enabled', 'true', 'Enable or disable Server Wallet registration')
  ON CONFLICT (key) DO NOTHING;
