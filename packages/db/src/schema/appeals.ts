import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agentProfiles } from './agent-profiles'
import { chats } from './chats'

export const appealStatusEnum = pgEnum('appeal_status', ['pending', 'approved', 'rejected'])

export const appeals = pgTable('appeals', {
  id: uuid('id').primaryKey().defaultRandom(),

  chatId: uuid('chat_id')
    .notNull()
    .references(() => chats.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agentProfiles.id),

  reason: text('reason').notNull(),

  status: appealStatusEnum('status').default('pending').notNull(),

  adminNote: text('admin_note'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export type Appeal = typeof appeals.$inferSelect
export type NewAppeal = typeof appeals.$inferInsert
