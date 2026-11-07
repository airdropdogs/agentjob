import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  jsonb,
  primaryKey,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { skillTags, frameworkTags, runtimeTags, agentTypeTags } from './tags'

export const onlineStatusEnum = pgEnum('online_status', ['online', 'busy', 'offline'])

export const agentProfiles = pgTable('agent_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),

  // One profile per user
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),

  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  avatarUrl: text('avatar_url'),

  // Short bio (Task Square replies)
  bio: varchar('bio', { length: 70 }),

  /** @deprecated First message is now free; kept for backward compat */
  priceFirstMsg: numeric('price_first_msg', { precision: 18, scale: 6 }).notNull(),
  priceSubsequent: numeric('price_subsequent', { precision: 18, scale: 6 }).notNull(),

  freeDailyMax:    integer('free_daily_max').default(20).notNull(),
  freeMessagesPerUser: integer('free_messages_per_user').default(1).notNull(),
  dailyReplyLimit: integer('daily_reply_limit').default(500).notNull(),

  // Tags: model/agentType FKs; skill/framework/runtime via junction tables
  modelTagId: uuid('model_tag_id'),
  agentTypeTagId: uuid('agent_type_tag_id').references(() => agentTypeTags.id, { onDelete: 'set null' }),

  // Legacy custom skills (deprecated)
  customSkillTags: jsonb('custom_skill_tags').$type<string[]>().default([]).notNull(),

  // Concurrent chat limit (replaces exclusiveMode; 1 = exclusive, default 2, max 5)
  maxConcurrentChats: integer('max_concurrent_chats').default(2).notNull(),
  /** @deprecated Use maxConcurrentChats instead */
  exclusiveMode: boolean('exclusive_mode').default(false).notNull(),
  activeChatId: uuid('active_chat_id'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),

  // online | busy | offline
  onlineStatus: onlineStatusEnum('online_status').default('offline').notNull(),

  // MCP / API key hash + heartbeat
  apiKeyHash: varchar('api_key_hash', { length: 64 }).notNull(),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),

  // Reputation NFT
  hasReputationNft: boolean('has_reputation_nft').default(false).notNull(),
  reputationNftTokenId: integer('reputation_nft_token_id'),

  // X (Twitter) verified
  xVerified: boolean('x_verified').default(false).notNull(),
  xUsername: varchar('x_username', { length: 50 }),

  // Off-chain reputation stats
  totalRevenue: numeric('total_revenue', { precision: 18, scale: 6 }).default('0').notNull(),
  totalHired: integer('total_hired').default(0).notNull(),
  totalChats: integer('total_chats').default(0).notNull(),
  totalRequests: integer('total_requests').default(0).notNull(),
  noResponseCount: integer('no_response_count').default(0).notNull(),
  successRate: numeric('success_rate', { precision: 5, scale: 4 }).default('1').notNull(),

  // Optimistic lock for exclusive activeChatId
  version: integer('version').default(0).notNull(),

  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [check('agent_profiles_free_messages_per_user_check', sql`${t.freeMessagesPerUser} BETWEEN 1 AND 100`)])

// Agent ↔ Skill (M:N, max 5)
export const agentSkillTags = pgTable(
  'agent_skill_tags',
  {
    agentProfileId: uuid('agent_profile_id')
      .notNull()
      .references(() => agentProfiles.id, { onDelete: 'cascade' }),
    skillTagId: uuid('skill_tag_id')
      .notNull()
      .references(() => skillTags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.agentProfileId, table.skillTagId] })]
)

// Agent ↔ Framework (M:N, max 2)
export const agentFrameworkTags = pgTable(
  'agent_framework_tags',
  {
    agentProfileId: uuid('agent_profile_id')
      .notNull()
      .references(() => agentProfiles.id, { onDelete: 'cascade' }),
    frameworkTagId: uuid('framework_tag_id')
      .notNull()
      .references(() => frameworkTags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.agentProfileId, table.frameworkTagId] })]
)

// Agent ↔ Runtime (M:N, max 2)
export const agentRuntimeTags = pgTable(
  'agent_runtime_tags',
  {
    agentProfileId: uuid('agent_profile_id')
      .notNull()
      .references(() => agentProfiles.id, { onDelete: 'cascade' }),
    runtimeTagId: uuid('runtime_tag_id')
      .notNull()
      .references(() => runtimeTags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.agentProfileId, table.runtimeTagId] })]
)

export type AgentProfile = typeof agentProfiles.$inferSelect
export type NewAgentProfile = typeof agentProfiles.$inferInsert
export type AgentSkillTag = typeof agentSkillTags.$inferSelect
export type AgentFrameworkTag = typeof agentFrameworkTags.$inferSelect
export type AgentRuntimeTag = typeof agentRuntimeTags.$inferSelect
