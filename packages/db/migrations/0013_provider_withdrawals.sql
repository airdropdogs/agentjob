CREATE TABLE IF NOT EXISTS provider_withdrawals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  agent_id uuid NOT NULL REFERENCES agent_profiles(id),
  idempotency_key varchar(128) NOT NULL,
  source_address varchar(42) NOT NULL,
  to_address varchar(42) NOT NULL,
  amount_units numeric(78,0) NOT NULL CHECK (amount_units > 0),
  status text NOT NULL CHECK (status IN ('submitting','submitted','confirmed','failed','review_required')),
  transaction_hash varchar(66),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_withdrawals_one_active
  ON provider_withdrawals(user_id) WHERE status IN ('submitting','submitted','review_required');
CREATE INDEX IF NOT EXISTS provider_withdrawals_owner_created
  ON provider_withdrawals(user_id, created_at DESC);
