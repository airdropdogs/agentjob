import { createHash, randomUUID } from 'crypto'
import {
  getRedisOptional,
  isRedisConfigured,
  redisLimiters,
  apiKeyRateLimit,
  ipRegisterLimit,
} from './redis-limiters'

export { isRedisConfigured, getRedisOptional, redisLimiters, apiKeyRateLimit, ipRegisterLimit }
export type { RedisLimiters } from './redis-limiters'

/** SHA-256 prefix of (salt + email), for Redis keys (no raw PII). */
export function rateLimitIdHash(email: string): string {
  const salt = process.env.RATE_LIMIT_ID_SALT ?? process.env.SESSION_SECRET ?? 'agentjob-dev-salt'
  return createHash('sha256')
    .update(salt)
    .update('\n')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 32)
}

const DEV_DAILY = new Map<string, number>()

/**
 * Daily Server Wallet quota counter (Redis incr + expire).
 * Key: sw:daily:{YYYY-MM-DD}  →  integer count
 * TTL: 48 h (auto-expires well after day boundary)
 */
export async function incrementServerWalletDailyCount(dateKey: string): Promise<number> {
  const redis = getRedisOptional()
  if (!redis) {
    const n = (DEV_DAILY.get(dateKey) ?? 0) + 1
    DEV_DAILY.set(dateKey, n)
    return n
  }
  const key = `sw:daily:${dateKey}`
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, 60 * 60 * 48)
  }
  return count
}

/** Undo one `incrementServerWalletDailyCount` when a registrant is rejected (e.g. quota race). */
export async function decrementServerWalletDailyCount(dateKey: string): Promise<void> {
  const redis = getRedisOptional()
  if (!redis) {
    const n = DEV_DAILY.get(dateKey) ?? 0
    if (n > 0) DEV_DAILY.set(dateKey, n - 1)
    return
  }
  await redis.decr(`sw:daily:${dateKey}`)
}

export async function getServerWalletDailyCount(dateKey: string): Promise<number> {
  const redis = getRedisOptional()
  if (!redis) return DEV_DAILY.get(dateKey) ?? 0
  const val = await redis.get<number>(`sw:daily:${dateKey}`)
  return val === null ? 0 : Number(val)
}

const REGISTER_LOCK_TTL_SEC = 15

export type RegisterAutoLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'busy' }

/**
 * Short distributed lock for Server Wallet registration (global quota + create).
 * TTL 15s — covers typical CDP + DB latency; no Redis dev: no lock.
 */
export async function withRegisterAutoLock<T>(
  dateKey: string,
  fn: () => Promise<T>,
): Promise<RegisterAutoLockResult<T>> {
  const redis = getRedisOptional()
  if (!redis) {
    return { ok: true, value: await fn() }
  }
  const lockKey = `lock:sw:reg:${dateKey}`
  const token = randomUUID()
  const acquired = await redis.set(lockKey, token, { nx: true, ex: REGISTER_LOCK_TTL_SEC })
  if (!acquired) {
    return { ok: false, error: 'busy' }
  }
  try {
    return { ok: true, value: await fn() }
  } finally {
    await redis.releaseLock(lockKey, token).catch(() => {})
  }
}

const IDEMP_TTL_SEC = 86_400

export type IdempHttpPayload = {
  status: number
  body: string
  headers: Record<string, string>
}

export async function idempotencyHttpGet(key: string): Promise<IdempHttpPayload | null> {
  const redis = getRedisOptional()
  if (!redis) return null
  const raw = await redis.get<string>(`idemp:http:${key}`)
  if (!raw) return null
  return JSON.parse(raw) as IdempHttpPayload
}

export async function idempotencyHttpSet(key: string, payload: IdempHttpPayload): Promise<void> {
  const redis = getRedisOptional()
  if (!redis) return
  await redis.set(`idemp:http:${key}`, JSON.stringify(payload), { ex: IDEMP_TTL_SEC })
}

export async function idempotencyStringGet(key: string): Promise<string | null> {
  const redis = getRedisOptional()
  if (!redis) return null
  return redis.get<string>(`idemp:str:${key}`)
}

export async function idempotencyStringSet(key: string, value: string): Promise<void> {
  const redis = getRedisOptional()
  if (!redis) return
  await redis.set(`idemp:str:${key}`, value, { ex: IDEMP_TTL_SEC })
}

const CACHE_TTL_DEFAULT = 60

/**
 * Read-through JSON cache (e.g. list endpoints). Serializes values with JSON.stringify.
 */
export async function cacheGetJson<T>(
  prefix: string,
  subKey: string,
  ttlSec: number,
  compute: () => Promise<T>,
): Promise<T> {
  const redis = getRedisOptional()
  const fullKey = `${prefix}:${subKey}`
  if (redis) {
    const hit = await redis.get<string>(fullKey).catch(() => null)
    if (hit) {
      try {
        return JSON.parse(hit) as T
      } catch {
        // corrupt entry — recompute
      }
    }
  }
  const data = await compute()
  if (redis) {
    await redis.set(fullKey, JSON.stringify(data), { ex: ttlSec || CACHE_TTL_DEFAULT }).catch(() => {})
  }
  return data
}
