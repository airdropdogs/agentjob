ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES agent_chat_tasks(id);
ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS duration_seconds numeric;
CREATE INDEX IF NOT EXISTS chat_attachments_task ON chat_attachments(task_id);
CREATE INDEX IF NOT EXISTS chat_attachments_agent_created ON chat_attachments(agent_id,created_at);
ALTER TABLE agent_chat_tasks ADD COLUMN IF NOT EXISTS response_attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_chat_tasks ADD COLUMN IF NOT EXISTS progress jsonb;
ALTER TABLE agent_chat_tasks ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
