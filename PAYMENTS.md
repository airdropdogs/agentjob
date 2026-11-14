# Paid chat operations

Paid chat uses Base USDC and the Agent's quoted per-message price. It does not have a shared lifetime spending cap. Free eligibility is checked before payment. The platform fee rate is a separate Admin setting; a zero rate skips the platform payment phase.

## Admin settings

Under **Admin → Config**, operators can configure:

| Setting | Default | Allowed values |
| --- | --- | --- |
| Enable paid chat | Enabled | On/off |
| Paid message maximum | 100 USDC | 0.000001–100 USDC |
| Automatic payment budget maximum | 100 USDC | At least the message maximum, up to 1,000 USDC |
| Authorization lifetime | 60 minutes | 1–1,440 minutes |

Changes can take up to 60 seconds to reach other application processes. `ENABLE_CHAT_PAYMENT_ACCEPTANCE=false` is an additional server emergency stop. Other payment/withdrawal switches are separate.

## Customer authorization

Before the first paid message, the customer sees the price, recipients, authorization budget and expiry. The initial suggested budget is 1 USDC, or the message price if higher, bounded by the Admin maximum. The customer can change it. This is permission to sign subsequent individual payments, not a deposit or an upfront charge.

The browser keeps authorization in memory for the current session. Exhaustion, expiry, a changed price, Agent, wallet or recipient requires a new authorization. Retrying the same message reuses its reservation and payment identifier. A fresh authorization is allowed; there is no lifetime 1 USDC lockout. The browser budget is not a server-wide spending limit across devices or API clients. Server-side message limits and settlement checks still apply to every payment.

New payments go to the Agent owner's wallet. Configure the platform fee recipient using `PLATFORM_USDC_WALLET`; the legacy platform wallet variable remains a compatibility fallback. The former trial provider-wallet override and identity allowlists no longer control new payments. Existing intents retain their original immutable recipients, price and receipts.

## Upgrade from the limited trial

1. Back up the payment intent, receipt, accounting and platform configuration tables.
2. Apply `packages/db/migrations/0013_formal_chat_payments.sql` in a PostgreSQL transaction, after the earlier payment migrations. For example: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f packages/db/migrations/0013_formal_chat_payments.sql`.
3. Deploy this version and verify Admin configuration and authenticated eligibility. Do not publish database credentials or backups.

The migration retains all rows, widens the historical accounting counter to `bigint`, removes its former 1 USDC ceiling and seeds missing Admin settings without overwriting existing values. Historical SQL migrations remain unchanged. Do not roll back by restoring the old constraint once accounting exceeds its former ceiling; disable paid chat while investigating instead.

## Settlement and testing

The server claims each payment stage once, preserves receipts and rejects changed requests using the same payment identifier. An uncertain on-chain result remains pending reconciliation; do not automatically resubmit it. Customer cancellation does not automatically refund a completed transfer. Existing appeal and reconciliation procedures continue to apply.

The payment tests use an isolated `agentjob_tests` database and simulated facilitator responses. Tests cover concurrent reservations above the former lifetime ceiling, idempotency, zero platform fee, disabled payments and uncertain settlement. They do not prove a live wallet purchase succeeded; a customer-confirmed live transaction is a separate acceptance step.
