ALTER TABLE agent_verification_runs DROP CONSTRAINT IF EXISTS agent_verification_runs_capability_check;
ALTER TABLE agent_verification_runs ADD CONSTRAINT agent_verification_runs_capability_check CHECK (capability IN ('text_chat','image_understanding','image_generation','image_editing','runtime_info'));
ALTER TABLE agent_runtime_info ADD COLUMN IF NOT EXISTS self_report jsonb;
