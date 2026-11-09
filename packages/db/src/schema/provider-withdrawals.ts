import { sql } from 'drizzle-orm'
import { pgTable, uuid, varchar, numeric, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core'
import { users } from './users'
import { agentProfiles } from './agent-profiles'

export const providerWithdrawals = pgTable('provider_withdrawals', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  agentId: uuid('agent_id').notNull().references(() => agentProfiles.id),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  sourceAddress: varchar('source_address', { length: 42 }).notNull(),
  toAddress: varchar('to_address', { length: 42 }).notNull(),
  amountUnits: numeric('amount_units', { precision: 78, scale: 0 }).notNull(),
  status: text('status').notNull(),
  transactionHash: varchar('transaction_hash', { length: 66 }),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex('provider_withdrawals_user_id_idempotency_key_key').on(table.userId, table.idempotencyKey),
  uniqueIndex('provider_withdrawals_one_active').on(table.userId).where(sql`${table.status} IN ('submitting','submitted','review_required')`),
  index('provider_withdrawals_owner_created').on(table.userId, table.createdAt.desc()),
  check('provider_withdrawals_amount_units_check', sql`${table.amountUnits} > 0`),
  check('provider_withdrawals_status_check', sql`${table.status} IN ('submitting','submitted','confirmed','failed','review_required')`),
])
