import { getFreeChatPolicy } from './free-chat-policy'
import { getDb } from './db'
import { platformConfig, CONFIG_KEYS } from '@agentjob/db'
import { eq } from 'drizzle-orm'

interface PlatformConfigValues {
  platformFeeRate: number
  minPriceUsdc: number
  maxPriceUsdc: number
  nftMintPriceUsdc: number
  tenderDailyLimit: number
  bidDailyLimit: number
  bidMinIntervalSecs: number
  msgRateGlobalPm: number
  msgRatePerChatPm: number
  walletTransferMinUsdc: number
  walletTransferCooldownDays: number
  /** Platform maximum for an Agent's per-user free allowance. */
  agentFreeMessagesPerUserMax: number
  /** Maximum free messages per user per day (configured by Admin) */
  freeUserDailyLimit: number
  /** Legacy lifetime free-message limit per user (configured by Admin) */
  freeUserLifetimeLimit: number
  /** Daily automatic Server Wallet registration limit */
  serverWalletDailyLimit: number
  serverWalletIpDailyLimit: number
  /** Enable or disable Server Wallet registration */
  serverWalletWithdrawalsEnabled: boolean
  serverWalletEnabled: boolean
}

const DEFAULTS: PlatformConfigValues = {
  platformFeeRate: 0.05,
  minPriceUsdc: 0.001,
  maxPriceUsdc: 100,
  nftMintPriceUsdc: 9.9,
  tenderDailyLimit: 3,
  bidDailyLimit: 20,
  bidMinIntervalSecs: 120,
  msgRateGlobalPm: 30,
  msgRatePerChatPm: 10,
  walletTransferMinUsdc: 1,
  walletTransferCooldownDays: 7,
  agentFreeMessagesPerUserMax: 100,
  freeUserDailyLimit: 2,
  freeUserLifetimeLimit: 20,
  serverWalletDailyLimit: 100,
  serverWalletIpDailyLimit: 2,
  serverWalletWithdrawalsEnabled: true,
  serverWalletEnabled: true,
}

let _configCache: PlatformConfigValues | null = null
let _cacheAt = 0
const CACHE_TTL = 60_000 // 60s

export async function getPlatformConfig(): Promise<PlatformConfigValues> {
  if (_configCache && Date.now() - _cacheAt < CACHE_TTL) {
    return { ..._configCache, ...await getFreeChatPolicy() }
  }

  const db = getDb()
  const rows = await db.select().from(platformConfig)

  const map: Record<string, string> = {}
  for (const row of rows) {
    map[row.key] = row.value
  }

  _configCache = {
    platformFeeRate: parseFloat(map[CONFIG_KEYS.PLATFORM_FEE_RATE] ?? String(DEFAULTS.platformFeeRate)),
    minPriceUsdc: parseFloat(map[CONFIG_KEYS.MIN_PRICE_USDC] ?? String(DEFAULTS.minPriceUsdc)),
    maxPriceUsdc: parseFloat(map[CONFIG_KEYS.MAX_PRICE_USDC] ?? String(DEFAULTS.maxPriceUsdc)),
    nftMintPriceUsdc: parseFloat(map[CONFIG_KEYS.NFT_MINT_PRICE_USDC] ?? String(DEFAULTS.nftMintPriceUsdc)),
    tenderDailyLimit: parseInt(map[CONFIG_KEYS.TENDER_DAILY_LIMIT] ?? String(DEFAULTS.tenderDailyLimit)),
    bidDailyLimit: parseInt(map[CONFIG_KEYS.BID_DAILY_LIMIT] ?? String(DEFAULTS.bidDailyLimit)),
    bidMinIntervalSecs: parseInt(map[CONFIG_KEYS.BID_MIN_INTERVAL_SECS] ?? String(DEFAULTS.bidMinIntervalSecs)),
    msgRateGlobalPm: parseInt(map[CONFIG_KEYS.MSG_RATE_GLOBAL_PM] ?? String(DEFAULTS.msgRateGlobalPm)),
    msgRatePerChatPm: parseInt(map[CONFIG_KEYS.MSG_RATE_PER_CHAT_PM] ?? String(DEFAULTS.msgRatePerChatPm)),
    walletTransferMinUsdc: parseFloat(map[CONFIG_KEYS.WALLET_TRANSFER_MIN_USDC] ?? String(DEFAULTS.walletTransferMinUsdc)),
    walletTransferCooldownDays: parseInt(map[CONFIG_KEYS.WALLET_TRANSFER_COOLDOWN_DAYS] ?? String(DEFAULTS.walletTransferCooldownDays)),
    agentFreeMessagesPerUserMax: 100,
    freeUserDailyLimit: parseInt(map[CONFIG_KEYS.FREE_USER_DAILY_LIMIT] ?? String(DEFAULTS.freeUserDailyLimit)),
    freeUserLifetimeLimit: parseInt(map[CONFIG_KEYS.FREE_USER_LIFETIME_LIMIT] ?? String(DEFAULTS.freeUserLifetimeLimit)),
    serverWalletDailyLimit: parseInt(map[CONFIG_KEYS.SERVER_WALLET_DAILY_LIMIT] ?? String(DEFAULTS.serverWalletDailyLimit)),
    serverWalletIpDailyLimit: parseInt(map[CONFIG_KEYS.SERVER_WALLET_IP_DAILY_LIMIT] ?? String(DEFAULTS.serverWalletIpDailyLimit)),
    serverWalletWithdrawalsEnabled: (map[CONFIG_KEYS.SERVER_WALLET_WITHDRAWALS_ENABLED] ?? 'true') === 'true',
    serverWalletEnabled: (map[CONFIG_KEYS.SERVER_WALLET_ENABLED] ?? 'true') === 'true',
  }
  _cacheAt = Date.now()
  return { ..._configCache, ...await getFreeChatPolicy() }
}

export async function updateConfigValue(key: string, value: string): Promise<void> {
  const db = getDb()
  await db
    .insert(platformConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformConfig.key, set: { value, updatedAt: new Date() } })
  _configCache = null // bust cache
}
