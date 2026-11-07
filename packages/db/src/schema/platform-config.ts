import { pgTable, varchar, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Platform config KV (admin-editable).
 * Keys: platform_fee_rate, min/max_price_usdc, nft_mint_price_usdc,
 * tender_daily_limit, bid_*, msg_rate_*_pm, wallet_transfer_*.
 */
export const platformConfig = pgTable('platform_config', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: text('value').notNull(),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export type PlatformConfig = typeof platformConfig.$inferSelect

// Typed config keys
export const CONFIG_KEYS = {
  PLATFORM_FEE_RATE: 'platform_fee_rate',
  MIN_PRICE_USDC: 'min_price_usdc',
  MAX_PRICE_USDC: 'max_price_usdc',
  NFT_MINT_PRICE_USDC: 'nft_mint_price_usdc',
  TENDER_DAILY_LIMIT: 'tender_daily_limit',
  BID_DAILY_LIMIT: 'bid_daily_limit',
  BID_MIN_INTERVAL_SECS: 'bid_min_interval_secs',
  MSG_RATE_GLOBAL_PM: 'msg_rate_global_pm',
  MSG_RATE_PER_CHAT_PM: 'msg_rate_per_chat_pm',
  // Wallet USDC transfer limits
  WALLET_TRANSFER_MIN_USDC: 'wallet_transfer_min_usdc',
  WALLET_TRANSFER_COOLDOWN_DAYS: 'wallet_transfer_cooldown_days',
  // First-free-message limits per user (configurable by Admin)
  AGENT_FREE_MESSAGES_PER_USER_MAX: 'agent_free_messages_per_user_max',
  FREE_USER_DAILY_LIMIT: 'free_user_daily_limit',       // Maximum free messages per user per day
  FREE_USER_LIFETIME_LIMIT: 'free_user_lifetime_limit', // Maximum lifetime free messages per user
  // Automatic Server Wallet registration without email
  SERVER_WALLET_DAILY_LIMIT: 'server_wallet_daily_limit', // Daily Server Wallet registration limit
  SERVER_WALLET_ENABLED: 'server_wallet_enabled',         // Registration enabled flag
} as const
