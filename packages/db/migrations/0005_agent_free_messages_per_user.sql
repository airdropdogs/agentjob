-- Existing one-time markers represent at least one previously consumed message.
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS free_messages_per_user integer NOT NULL DEFAULT 1;
ALTER TABLE user_agent_free_used ADD COLUMN IF NOT EXISTS used_count integer NOT NULL DEFAULT 1;

-- Recover any additional historical free tasks, including timed-out tasks: the
-- original request consumed its allowance even if its Agent did not respond.
INSERT INTO user_agent_free_used(user_id, agent_id, used_at, used_count)
SELECT user_id, agent_id, min(created_at), count(*)::integer
FROM agent_chat_tasks
WHERE amount_usdc = 0
GROUP BY user_id, agent_id
ON CONFLICT(user_id, agent_id) DO UPDATE
SET used_count = greatest(user_agent_free_used.used_count, EXCLUDED.used_count);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_profiles'::regclass AND conname='agent_profiles_free_messages_per_user_check') THEN
    ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_free_messages_per_user_check CHECK (free_messages_per_user BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='user_agent_free_used'::regclass AND conname='user_agent_free_used_count_check') THEN
    ALTER TABLE user_agent_free_used ADD CONSTRAINT user_agent_free_used_count_check CHECK (used_count >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chat_free_requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  requested_chat_id uuid,
  chat_id uuid NOT NULL,
  messages_hash text NOT NULL,
  decision text NOT NULL CONSTRAINT chat_free_requests_decision_check CHECK (decision IN ('free', 'paid')),
  task_id uuid,
  free_messages_remaining integer,
  slot_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, idempotency_key)
);
