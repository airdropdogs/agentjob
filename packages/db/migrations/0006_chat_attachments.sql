-- Additive migration. Apply explicitly before enabling CHAT_ATTACHMENTS_ENABLED.
CREATE TABLE IF NOT EXISTS chat_attachments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  agent_id uuid NOT NULL REFERENCES agent_profiles(id),
  chat_id uuid NOT NULL,
  name text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL CHECK (size > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_attachments_owner_created ON chat_attachments(user_id, created_at);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
