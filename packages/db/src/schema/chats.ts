import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  numeric,
  integer,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agentProfiles } from './agent-profiles'

export const chatStatusEnum = pgEnum('chat_status', ['active', 'completed', 'cancelled'])
export const paymentStatusEnum = pgEnum('payment_status', ['success', 'partial_fail', 'failed', 'pending'])

export const chats = pgTable('chats', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agentProfiles.id),

  // First vs subsequent message pricing
  isFirstChat: integer('is_first_chat').default(1).notNull(),

  totalMessages: integer('total_messages').default(0).notNull(),
  totalSpent: numeric('total_spent', { precision: 18, scale: 6 }).default('0').notNull(),

  status: chatStatusEnum('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
})

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: uuid('chat_id')
    .notNull()
    .references(() => chats.id),
  payerId: uuid('payer_id')
    .notNull()
    .references(() => users.id),

  amountPlatform: numeric('amount_platform', { precision: 18, scale: 6 }).notNull(),
  amountAgent: numeric('amount_agent', { precision: 18, scale: 6 }).notNull(),

  txPlatform: varchar('tx_platform', { length: 100 }),
  txAgent: varchar('tx_agent', { length: 100 }),

  x402PaymentId: varchar('x402_payment_id', { length: 200 }),

  status: paymentStatusEnum('status').default('pending').notNull(),
  failureReason: varchar('failure_reason', { length: 500 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export type Chat = typeof chats.$inferSelect
export type NewChat = typeof chats.$inferInsert
export type Payment = typeof payments.$inferSelect
export type NewPayment = typeof payments.$inferInsert
