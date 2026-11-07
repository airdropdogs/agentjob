-- Apply before enabling AGENT_VERIFICATION_ENABLED. No consumer/payment data is changed.
ALTER TABLE agent_chat_tasks ADD COLUMN IF NOT EXISTS verification_run_id uuid;
CREATE TABLE IF NOT EXISTS agent_verification_runs (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agent_profiles(id),
  admin_id uuid NOT NULL REFERENCES users(id),
  request_key uuid NOT NULL UNIQUE,
  capability text NOT NULL CHECK (capability IN ('text_chat','image_understanding','image_generation','image_editing')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','evaluating','passed','failed','error','review_required','cancelled','revoked')),
  task_id uuid REFERENCES agent_chat_tasks(id),
  phase integer NOT NULL DEFAULT 0,
  challenge jsonb NOT NULL,
  result jsonb,
  suite_version text NOT NULL DEFAULT '1',
  evaluator_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz NOT NULL,
  completed_at timestamptz,
  valid_until timestamptz,
  lease_until timestamptz,
  revision integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS verification_agent_created ON agent_verification_runs(agent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS verification_active_agent ON agent_verification_runs(agent_id)
  WHERE status IN ('queued','running','evaluating');
CREATE TABLE IF NOT EXISTS agent_verification_permissions (
  agent_id uuid PRIMARY KEY REFERENCES agent_profiles(id),
  recorded_by uuid NOT NULL REFERENCES users(id),
  policy_version text NOT NULL,
  service_revision text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
