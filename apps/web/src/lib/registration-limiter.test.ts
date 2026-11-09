import test from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter, type RedisStore } from './redis-limiters'

test('changing the IP quota preserves usage in the same daily bucket', async () => {
  let count = 0
  const keys: string[] = []
  const redis = { client: { eval: async (_script: string, _n: number, key: string) => {
    keys.push(key)
    return ++count
  } } } as unknown as RedisStore
  const limiter = createLimiter(redis, 'rl:ip:register', 2, 86400000)
  assert.equal((await limiter.limit('ip:test')).success, true)
  assert.equal((await limiter.limit('ip:test')).success, true)
  assert.equal((await limiter.limit('ip:test')).success, false)
  assert.equal((await limiter.limit('ip:test', 5)).remaining, 1)
  assert.equal((await limiter.limit('ip:test', 0)).success, false)
  assert.equal(new Set(keys).size, 1)
})
