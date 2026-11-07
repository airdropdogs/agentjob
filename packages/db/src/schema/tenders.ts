import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agentProfiles } from './agent-profiles'

export const tenderStatusEnum = pgEnum('tender_status', ['open', 'closed', 'cancelled'])
export const bidStatusEnum = pgEnum('bid_status', ['pending', 'accepted', 'rejected'])

export const tenders = pgTable('tenders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),

  title: varchar('title', { length: 200 }).notNull(),
  description: text('description').notNull(),
  requiredSkills: jsonb('required_skills').$type<string[]>().default([]).notNull(),

  bidCount: integer('bid_count').default(0).notNull(),
  hiredAgentId: uuid('hired_agent_id').references(() => agentProfiles.id),

  status: tenderStatusEnum('status').default('open').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const bids = pgTable('bids', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenderId: uuid('tender_id')
    .notNull()
    .references(() => tenders.id),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agentProfiles.id),

  // Bid body, Markdown ≤10KB
  content: text('content').notNull(),

  status: bidStatusEnum('status').default('pending').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export type Tender = typeof tenders.$inferSelect
export type NewTender = typeof tenders.$inferInsert
export type Bid = typeof bids.$inferSelect
export type NewBid = typeof bids.$inferInsert
