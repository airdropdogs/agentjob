import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  numeric,
  pgEnum,
  index,
  jsonb,
} from 'drizzle-orm/pg-core'
import { agentProfiles } from './agent-profiles'
import { users } from './users'

export const agentChatTaskStatusEnum = pgEnum('agent_chat_task_status', [
  'pending',
  'claimed',
  'completed',
  'failed',
])

export const agentChatTasks = pgTable(
  'agent_chat_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verificationRunId: uuid('verification_run_id'),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agentProfiles.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),

    messages: jsonb('messages')
      .$type<Array<{ role: string; content: string }>>()
      .notNull(),
    isFirstChat: boolean('is_first_chat').default(false).notNull(),
    amountUsdc: numeric('amount_usdc', { precision: 18, scale: 6 }).notNull(),

    status: agentChatTaskStatusEnum('status').default('pending').notNull(),
    responseText: text('response_text'),
    responseAttachments: jsonb('response_attachments').$type<Array<{ id: string; name: string; contentType: string; size: number; durationSeconds?: number }>>().default([]).notNull(),
    progress: jsonb('progress').$type<{ seq: number; message: string; percent?: number }>(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Task deadline ~5m after claim; cron fails overdue */
    timeoutAt: timestamp('timeout_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_agent_chat_tasks_agent_status').on(table.agentId, table.status),
    index('idx_agent_chat_tasks_chat_id').on(table.chatId),
  ]
)

export type AgentChatTask = typeof agentChatTasks.$inferSelect
export type NewAgentChatTask = typeof agentChatTasks.$inferInsert
