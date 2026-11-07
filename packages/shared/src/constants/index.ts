export const PLATFORM_FEE_PERCENT = 10
export const HEARTBEAT_TIMEOUT_SECONDS = 35
export const MAX_BIDS_PER_TENDER = 50
export const MAX_CUSTOM_SKILL_TAGS = 3
export const CUSTOM_SKILL_TAG_MAX_CHARS = 3
export const ROUND_TIMEOUT_HOURS = 24
export const RELAYER_RECOVERY_MINUTES = 2

export const PRICE_MIN_USDC = '0.01'
export const PRICE_MAX_USDC = '100.00'

// ── First-free-message policy ──────────────────────────────────────────────────────────────

/** Default daily Agent free allowance (editable by the provider) */
export const FREE_DAILY_MAX_DEFAULT = 20
/** Maximum configurable daily Agent free allowance */
export const FREE_DAILY_MAX_CEILING = 100
/** Default daily Agent reply limit (0 = unlimited) */
export const DAILY_REPLY_LIMIT_DEFAULT = 500
/** Maximum configurable daily Agent reply limit */
export const DAILY_REPLY_LIMIT_CEILING = 10000

/** Warn when the remaining capacity ratio is at or below this threshold (20%) */
export const FREE_SLOT_WARNING_RATIO = 0.2

/**
 * The following values are configured by Admin through platform_config;
 * these constants are fallbacks when no stored setting exists.
 */
/** Maximum free messages per user per day (configured by Admin) */
export const FREE_USER_DAILY_LIMIT_DEFAULT = 2
/** Legacy lifetime free-message limit per user (configured by Admin) */
export const FREE_USER_LIFETIME_LIMIT_DEFAULT = 20

export const MSG_MAX_LENGTH = 10000
export const TENDER_TITLE_MIN_LENGTH = 5
export const TENDER_TITLE_MAX_LENGTH = 200
export const TENDER_DESC_MIN_LENGTH = 20
export const TENDER_DESC_MAX_LENGTH = 5000
export const BID_PROPOSAL_MAX_LENGTH = 10240

export const BASE_CHAIN_ID = 8453
export const BASE_SEPOLIA_CHAIN_ID = 84532

export const USDC_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const USDC_DECIMALS = 6

export const TRUST_LEVELS = {
  LV0: 0,
  LV1_EMAIL: 1,
  LV2_TWITTER: 2,
  LV3_BOTH: 3,
  LV4_NFT: 4,
} as const

export const TENDER_LIMITS_BY_TRUST = {
  [TRUST_LEVELS.LV0]: { daily: 0, intervalMin: Infinity },
  [TRUST_LEVELS.LV1_EMAIL]: { daily: 3, intervalMin: 60 },
  [TRUST_LEVELS.LV2_TWITTER]: { daily: 5, intervalMin: 30 },
  [TRUST_LEVELS.LV3_BOTH]: { daily: 8, intervalMin: 20 },
  [TRUST_LEVELS.LV4_NFT]: { daily: 15, intervalMin: 10 },
} as const
