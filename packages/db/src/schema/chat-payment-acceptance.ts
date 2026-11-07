import { pgTable, text, uuid, integer, timestamp, jsonb, uniqueIndex, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const chatPaymentAcceptanceBudgets = pgTable('chat_payment_acceptance_budgets', {
  campaignId: text('campaign_id').primaryKey(),
  reservedMicro: integer('reserved_micro').notNull().default(0),
}, table => [check('chat_acceptance_budget_cap', sql`${table.reservedMicro} >= 0 and ${table.reservedMicro} <= 1000000`)])

export const chatPaymentAcceptanceIntents = pgTable('chat_payment_acceptance_intents', {
  id: uuid('id').primaryKey(),
  campaignId: text('campaign_id').notNull().references(() => chatPaymentAcceptanceBudgets.campaignId),
  userId: uuid('user_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  chatId: uuid('chat_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  messagesHash: text('messages_hash').notNull(),
  payer: text('payer').notNull(),
  platformRecipient: text('platform_recipient').notNull(),
  agentRecipient: text('agent_recipient').notNull(),
  totalMicro: integer('total_micro').notNull(),
  platformFeeMicro: integer('platform_fee_micro').notNull(),
  platformStatus: text('platform_status').notNull().default('pending'),
  agentStatus: text('agent_status').notNull().default('pending'),
  taskId: uuid('task_id'),
  delivery: jsonb('delivery').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('chat_acceptance_idempotency').on(table.campaignId, table.userId, table.idempotencyKey),
  check('chat_acceptance_amounts', sql`${table.totalMicro} > 0 and ${table.totalMicro} <= 1000000 and ${table.platformFeeMicro} >= 0 and ${table.platformFeeMicro} < ${table.totalMicro}`),
  check('chat_acceptance_platform_status', sql`${table.platformStatus} in ('pending', 'processing', 'settling', 'settled', 'uncertain')`),
  check('chat_acceptance_agent_status', sql`${table.agentStatus} in ('pending', 'processing', 'settling', 'settled', 'uncertain')`),
])

export const chatPaymentAcceptanceReceipts = pgTable('chat_payment_acceptance_receipts', {
  transaction: text('transaction').primaryKey(),
  intentId: uuid('intent_id').notNull().references(() => chatPaymentAcceptanceIntents.id),
  stage: text('stage').notNull(),
  amountMicro: integer('amount_micro').notNull(),
  recipient: text('recipient').notNull(),
  payer: text('payer').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('chat_acceptance_stage_receipt').on(table.intentId, table.stage),
  check('chat_acceptance_receipt_stage', sql`${table.stage} in ('platform_fee', 'agent')`),
])
