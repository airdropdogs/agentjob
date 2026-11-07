import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

test('Redis outage preserves login rate limiting and bypasses only the read-through cache', async () => {
  process.env.REDIS_URL = 'redis://127.0.0.1:1'
  const { redisLimiters, getRedisOptional } = await import('./redis-limiters')
  const { middleware } = await import('../middleware')
  const { cacheGetJson, withRegisterAutoLock, idempotencyHttpGet, idempotencyHttpSet, idempotencyStringSet } = await import('./rate-limit')
  const limiter = redisLimiters!.cdpSyncIpLimit
  const originalLimit = limiter.limit
  const redis = getRedisOptional()!
  const originalGet = redis.get
  const originalSet = redis.set
  const request = () => new NextRequest('https://agent-job.ai/api/auth/cdp-sync', {
    method: 'POST', headers: { 'x-forwarded-for': '192.0.2.123' },
  })
  try {
    limiter.limit = async () => { throw new TypeError('n.map is not a function') }
    for (let i = 0; i < 10; i++) assert.equal((await middleware(request())).status, 200)
    assert.equal((await middleware(request())).status, 429)
    limiter.limit = async () => ({ success: false, limit: 10, remaining: 0, reset: Date.now(), pending: Promise.resolve() })
    assert.equal((await middleware(request())).status, 429)
    redis.get = async () => { throw new TypeError('n.map is not a function') }
    redis.set = async () => { throw new Error('Redis unavailable') }
    let called = false
    await assert.rejects(withRegisterAutoLock('test', async () => { called = true }), /Redis unavailable/)
    assert.equal(called, false)
    await assert.rejects(idempotencyHttpGet('test'), /n.map/)
    await assert.rejects(idempotencyHttpSet('test', { status: 200, body: '{}', headers: {} }), /Redis unavailable/)
    await assert.rejects(idempotencyStringSet('test', 'value'), /Redis unavailable/)
    assert.deepEqual(await cacheGetJson('cache', 'test', 60, async () => ['database-result']), ['database-result'])
    await assert.rejects(cacheGetJson('cache', 'test', 60, async () => { throw new Error('database unavailable') }), /database unavailable/)
  } finally {
    limiter.limit = originalLimit
    redis.get = originalGet
    redis.set = originalSet
  }
})


test('production requires Redis while build and development remain credential-free', async () => {
  const { getRedisOptional } = await import('./redis-limiters')
  const saved = { NODE_ENV: process.env.NODE_ENV, REDIS_URL: process.env.REDIS_URL, NEXT_PHASE: process.env.NEXT_PHASE }
  try {
    Object.assign(process.env, { NODE_ENV: 'production' })
    delete process.env.REDIS_URL
    delete process.env.NEXT_PHASE
    assert.throws(() => getRedisOptional(), /REDIS_URL is required/)
    process.env.NEXT_PHASE = 'phase-production-build'
    assert.doesNotThrow(() => getRedisOptional())
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
