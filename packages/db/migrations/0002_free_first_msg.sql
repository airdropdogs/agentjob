-- Migration: first-message free allowance
-- Adds three tables, two agent_profiles columns, one users column and two platform_config defaults

-- ── agent_profiles：Add free-message settings ────────────────────────────────────────
ALTER TABLE agent_profiles
  ADD COLUMN IF NOT EXISTS free_daily_max    INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS daily_reply_limit INTEGER NOT NULL DEFAULT 500;

-- ── users：Add the lifetime free-message counter ──────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS lifetime_free_count INTEGER NOT NULL DEFAULT 0;

-- ── New table: persistent first-free-message record per user and Agent ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_agent_free_used (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id  UUID NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  used_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_uafu_agent_id ON user_agent_free_used(agent_id);

-- ── New table: daily Agent statistics ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_daily_stats (
  agent_id          UUID NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  stat_date         DATE NOT NULL,
  free_users_count  INTEGER NOT NULL DEFAULT 0,
  total_replies     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, stat_date)
);

-- ── New table: daily user free-message statistics ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_daily_free_stats (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stat_date  DATE NOT NULL,
  free_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, stat_date)
);

-- ── platform_config：Insert defaults (editable by Admin) ────────────────────────
INSERT INTO platform_config (key, value, description)
VALUES
  ('free_user_daily_limit',    '2',  'Maximum first-free-message uses per user per day')
  ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_config (key, value, description)
VALUES
  ('free_user_lifetime_limit', '20', 'Maximum lifetime first-free-message uses per user')
  ON CONFLICT (key) DO NOTHING;
