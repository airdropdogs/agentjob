BEGIN;
ALTER TABLE chat_payment_acceptance_intents DROP CONSTRAINT IF EXISTS chat_acceptance_amounts;
ALTER TABLE chat_payment_acceptance_intents ADD CONSTRAINT chat_acceptance_amounts CHECK(total_micro > 0 AND total_micro <= 1000000 AND platform_fee_micro >= 0 AND platform_fee_micro < total_micro);
COMMIT;
