-- Queued tests wait without occupying an execution slot. One running test per Agent.
ALTER TABLE agent_verification_runs ADD COLUMN IF NOT EXISTS batch_key uuid;
ALTER TABLE agent_verification_runs ADD COLUMN IF NOT EXISTS queue_order integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS verification_batch ON agent_verification_runs(batch_key);
DROP INDEX IF EXISTS verification_active_agent;
CREATE UNIQUE INDEX verification_active_agent ON agent_verification_runs(agent_id)
  WHERE status IN ('running','evaluating');
