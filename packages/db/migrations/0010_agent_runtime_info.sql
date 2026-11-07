CREATE TABLE IF NOT EXISTS agent_runtime_info (
  agent_id uuid PRIMARY KEY REFERENCES agent_profiles(id) ON DELETE CASCADE,
  reported jsonb,
  approved jsonb,
  approved_by uuid REFERENCES users(id),
  reported_at timestamptz,
  approved_at timestamptz
);
