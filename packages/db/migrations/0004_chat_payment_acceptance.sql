-- Explicit acceptance-only migration. No funds move and no existing tables change.
CREATE TABLE IF NOT EXISTS chat_payment_acceptance_budgets (
  campaign_id text PRIMARY KEY,
  reserved_micro integer NOT NULL DEFAULT 0,
  CONSTRAINT chat_acceptance_budget_cap CHECK (reserved_micro >= 0 AND reserved_micro <= 1000000)
);
CREATE TABLE IF NOT EXISTS chat_payment_acceptance_intents (
  id uuid PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES chat_payment_acceptance_budgets(campaign_id),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  messages_hash text NOT NULL,
  payer text NOT NULL,
  platform_recipient text NOT NULL,
  agent_recipient text NOT NULL,
  total_micro integer NOT NULL,
  platform_fee_micro integer NOT NULL,
  platform_status text NOT NULL DEFAULT 'pending',
  agent_status text NOT NULL DEFAULT 'pending',
  task_id uuid,
  delivery jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_acceptance_amounts CHECK(total_micro > 0 AND total_micro <= 1000000 AND platform_fee_micro > 0 AND platform_fee_micro < total_micro),
  CONSTRAINT chat_acceptance_platform_status CHECK(platform_status IN ('pending','processing','settling','settled','uncertain')),
  CONSTRAINT chat_acceptance_agent_status CHECK(agent_status IN ('pending','processing','settling','settled','uncertain'))
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_acceptance_idempotency ON chat_payment_acceptance_intents(campaign_id,user_id,idempotency_key);
CREATE TABLE IF NOT EXISTS chat_payment_acceptance_receipts (
  transaction text PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES chat_payment_acceptance_intents(id),
  stage text NOT NULL CHECK(stage IN ('platform_fee','agent')),
  amount_micro integer NOT NULL,
  recipient text NOT NULL,
  payer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_acceptance_stage_receipt ON chat_payment_acceptance_receipts(intent_id,stage);
