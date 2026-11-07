import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core'
import { users } from './users'

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),

  userId: uuid('user_id').references(() => users.id),

  action: varchar('action', { length: 100 }).notNull(),

  targetType: varchar('target_type', { length: 50 }),
  targetId: varchar('target_id', { length: 100 }),

  metadata: jsonb('metadata'),

  ipAddress: varchar('ip_address', { length: 45 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert
