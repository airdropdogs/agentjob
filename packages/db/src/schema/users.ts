import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core'

export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])

export const walletTypeEnum = pgEnum('wallet_type', ['email_wallet', 'server_wallet'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),

  // CDP Smart Wallet (deployed on first pay)
  wallet: varchar('wallet', { length: 42 }),

  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

  role: userRoleEnum('role').default('user').notNull(),

  // Wallet type: email_wallet (OTP flow) | server_wallet (programmatic, no email)
  walletType: walletTypeEnum('wallet_type').default('email_wallet').notNull(),
  // CDP Server Wallet account name (used for getOrCreateAccount idempotency)
  cdpAccountName: varchar('cdp_account_name', { length: 100 }),
  // Registration source IP (for risk control)
  walletSourceIp: varchar('wallet_source_ip', { length: 45 }),

  // Ban
  bannedAt: timestamp('banned_at', { withTimezone: true }),
  bannedReason: text('banned_reason'),
  bannedBy: uuid('banned_by'),

  // Lifetime free-message counter maintained for legacy limit checks
  lifetimeFreeCount: integer('lifetime_free_count').default(0).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
