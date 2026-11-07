/** Task Square: posts/replies; authorId = users.id (human or agent account) */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  primaryKey,
} from 'drizzle-orm/pg-core'
import { users } from './users'

// Channels
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
})

// Post tags (forum; not skill_tags)
export const taskTags = pgTable('task_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
})

// Posts
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  title: text('title').notNull(),
  body: text('body').notNull(),
  channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),

  voteCount: integer('vote_count').default(0).notNull(),
  replyCount: integer('reply_count').default(0).notNull(),
  /** Best reply; FK added in migration (breaks circular ref) */
  bestReplyId: uuid('best_reply_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Replies (flat, no parent_id)
/** Denormalized author at post time */
export const replyAuthorSnapshotSchema = {
  bio: text(),
  skills: jsonb().$type<string[]>(),
  model: text(),
  avatarUrl: text(),
  agentId: uuid(),
  isOnline: jsonb().$type<boolean>(),
} as const

export const replies = pgTable('replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id')
    .notNull()
    .references(() => posts.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  body: text('body').notNull(),
  voteCount: integer('vote_count').default(0).notNull(),
  /** Author card: bio/skills/model/avatar/agentId/wallet/isOnline */
  authorSnapshot: jsonb('author_snapshot').$type<{
    bio?: string | null
    skills?: string[] | null
    model?: string | null
    avatarUrl?: string | null
    agentId?: string | null
    wallet?: string | null
    isOnline?: boolean | null
  }>(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Votes
export const postVotes = pgTable(
  'post_votes',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.accountId] })]
)

export const replyVotes = pgTable(
  'reply_votes',
  {
    replyId: uuid('reply_id')
      .notNull()
      .references(() => replies.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.replyId, t.accountId] })]
)

// Post ↔ tag M:N
export const postTags = pgTable(
  'post_tags',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => taskTags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })]
)

export type Channel = typeof channels.$inferSelect
export type NewChannel = typeof channels.$inferInsert
export type TaskTag = typeof taskTags.$inferSelect
export type NewTaskTag = typeof taskTags.$inferInsert
export type Post = typeof posts.$inferSelect
export type NewPost = typeof posts.$inferInsert
export type Reply = typeof replies.$inferSelect
export type NewReply = typeof replies.$inferInsert
export type PostVote = typeof postVotes.$inferSelect
export type ReplyVote = typeof replyVotes.$inferSelect
export type PostTag = typeof postTags.$inferSelect
