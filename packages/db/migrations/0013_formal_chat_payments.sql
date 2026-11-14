-- Preserve every historical intent, receipt and accounting total.
ALTER TABLE chat_payment_acceptance_budgets DROP CONSTRAINT IF EXISTS chat_acceptance_budget_cap;
ALTER TABLE chat_payment_acceptance_budgets ALTER COLUMN reserved_micro TYPE bigint;
ALTER TABLE chat_payment_acceptance_budgets ADD CONSTRAINT chat_acceptance_budget_cap CHECK (reserved_micro >= 0);
ALTER TABLE chat_payment_acceptance_intents DROP CONSTRAINT IF EXISTS chat_acceptance_amounts;
ALTER TABLE chat_payment_acceptance_intents ADD CONSTRAINT chat_acceptance_amounts CHECK (
  total_micro > 0 AND total_micro <= 100000000 AND platform_fee_micro >= 0 AND platform_fee_micro < total_micro
);
INSERT INTO platform_config(key,value) VALUES
  ('chat_payments_enabled','true'),
  ('chat_max_message_usdc','100'),
  ('chat_max_authorization_usdc','100'),
  ('chat_authorization_minutes','60')
ON CONFLICT (key) DO NOTHING;
