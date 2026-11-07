import { pgTable, uuid, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'

export const userWalletSettings = pgTable('user_wallet_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  lastUsdcTransferAt: timestamp('last_usdc_transfer_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export type UserWalletSettings = typeof userWalletSettings.$inferSelect
export type NewUserWalletSettings = typeof userWalletSettings.$inferInsert
