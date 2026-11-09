import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'

// JSON values retain their caller-provided representation; counters use INCR.
export class RedisStore {
  readonly client: Redis
  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 5000, retryStrategy: (attempt) => Math.min(attempt * 200, 2000) })
    this.client.on('error', () => console.warn('[redis] Connection unavailable'))
  }
  async get<T = string>(key: string): Promise<T | null> {
    const value = await this.client.get(key)
    return value as T | null
  }
  async set(key: string, value: string, options: { nx?: boolean; ex: number }): Promise<'OK' | null> {
    return options.nx
      ? this.client.set(key, value, 'EX', options.ex, 'NX')
      : this.client.set(key, value, 'EX', options.ex)
  }
  incr(key: string) { return this.client.incr(key) }
  decr(key: string) { return this.client.decr(key) }
  expire(key: string, seconds: number) { return this.client.expire(key, seconds) }
  del(key: string) { return this.client.del(key) }
  releaseLock(key: string, token: string) {
    return this.client.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, key, token)
  }
}

export function isRedisConfigured(): boolean { return Boolean(process.env.REDIS_URL?.trim()) }
let redisSingleton: RedisStore | null | undefined
export function getRedisOptional(): RedisStore | null {
  if (!isRedisConfigured() && process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
    throw new Error('REDIS_URL is required in production')
  }
  if (redisSingleton === undefined) redisSingleton = isRedisConfigured() ? new RedisStore(process.env.REDIS_URL!) : null
  return redisSingleton
}

const FIXED_WINDOW = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`
const SLIDING_WINDOW = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[2])
local n = redis.call('ZCARD', KEYS[1])
if n < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return n + 1
end
return tonumber(ARGV[3]) + 1
`

export function createLimiter(redis: RedisStore, prefix: string, maximum: number, windowMs: number, sliding = false) {
  return {
    async limit(id: string, configuredMaximum = maximum) {
      const now = Date.now()
      const reset = (Math.floor(now / windowMs) + 1) * windowMs
      const count = Number(sliding
        ? await redis.client.eval(SLIDING_WINDOW, 1, `${prefix}:${id}`, now, windowMs, configuredMaximum, randomUUID())
        : await redis.client.eval(FIXED_WINDOW, 1, `${prefix}:${Math.floor(now / windowMs)}:${id}`, reset - now))
      return { success: count <= configuredMaximum, limit: configuredMaximum, remaining: Math.max(0, configuredMaximum - count), reset: sliding ? now + windowMs : reset, pending: Promise.resolve() }
    },
  }
}

function newLimiters() {
  const redis = getRedisOptional()
  if (!redis) return null
  return {
    apiKeyRateLimit: createLimiter(redis, 'rl:apikey', 100, 60000, true),
    ipRegisterLimit: createLimiter(redis, 'rl:ip:register', 2, 86400000),
    otpIpLimit: createLimiter(redis, 'rl:otp:ip', 5, 600000),
    otpEmailLimit: createLimiter(redis, 'rl:otp:email', 5, 600000),
    cdpSyncIpLimit: createLimiter(redis, 'rl:cdp:ip', 10, 600000),
    chatIpLimit: createLimiter(redis, 'rl:chat:ip', 60, 60000),
    agentsPostIpLimit: createLimiter(redis, 'rl:agents:post:ip', 10, 3600000),
  }
}
export type RedisLimiters = NonNullable<ReturnType<typeof newLimiters>>
export const redisLimiters = newLimiters()
export const apiKeyRateLimit = redisLimiters?.apiKeyRateLimit ?? null
export const ipRegisterLimit = redisLimiters?.ipRegisterLimit ?? null
