import {
  pgTable,
  uuid,
  date,
  integer,
  timestamp,
  primaryKey,
  check,
  text,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { agentProfiles } from './agent-profiles'

/** Lifetime consumed free messages for each user/Agent pair, across all chats. */
export const userAgentFreeUsed = pgTable(
  'user_agent_free_used',
  {
    userId:  uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull().references(() => agentProfiles.id, { onDelete: 'cascade' }),
    usedCount: integer('used_count').default(1).notNull(),
    usedAt:  timestamp('used_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.agentId] }), check('user_agent_free_used_count_check', sql`${t.usedCount} >= 1`)]
)

/** Agent daily free message usage and total replies, grouped by UTC date. */
export const agentDailyStats = pgTable(
  'agent_daily_stats',
  {
    agentId:        uuid('agent_id').notNull().references(() => agentProfiles.id, { onDelete: 'cascade' }),
    statDate:       date('stat_date').notNull(),
    freeUsersCount: integer('free_users_count').default(0).notNull(),
    totalReplies:   integer('total_replies').default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.statDate] })]
)

/**
 * Daily free-message usage per user
 * Grouped by (user_id, stat_date), resetting by UTC date
 */
export const userDailyFreeStats = pgTable(
  'user_daily_free_stats',
  {
    userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    statDate:  date('stat_date').notNull(),
    freeCount: integer('free_count').default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.statDate] })]
)

export type UserAgentFreeUsed   = typeof userAgentFreeUsed.$inferSelect
export type AgentDailyStats     = typeof agentDailyStats.$inferSelect
export type UserDailyFreeStats  = typeof userDailyFreeStats.$inferSelect

export const chatFreeRequests = pgTable('chat_free_requests', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  agentId: uuid('agent_id').notNull().references(() => agentProfiles.id, { onDelete: 'cascade' }),
  requestedChatId: uuid('requested_chat_id'),
  chatId: uuid('chat_id').notNull(),
  messagesHash: text('messages_hash').notNull(),
  decision: text('decision').$type<'free' | 'paid'>().notNull(),
  taskId: uuid('task_id'),
  freeMessagesRemaining: integer('free_messages_remaining'),
  slotHint: text('slot_hint'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.userId, t.idempotencyKey] }), check('chat_free_requests_decision_check', sql`${t.decision} IN ('free', 'paid')`)])
