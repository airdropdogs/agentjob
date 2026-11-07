import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { RedisStore, createLimiter } from './redis-limiters'

// Opt in with isolated test services, never production connection variables.
test('Redis TCP preserves values, expiry, lock ownership and concurrent limits', { skip: !process.env.TEST_REDIS_URL }, async () => {
  const redis = new RedisStore(process.env.TEST_REDIS_URL!)
  const prefix = `integration:${randomUUID()}`
  try {
    const payload = JSON.stringify({ status: 200, body: '{"ok":true}', headers: {} })
    await redis.set(`${prefix}:json`, payload, { ex: 60 })
    assert.equal(await redis.get(`${prefix}:json`), payload)
    assert.equal(await redis.incr(`${prefix}:count`), 1)
    assert.equal(Number(await redis.get(`${prefix}:count`)), 1)
    await redis.expire(`${prefix}:count`, 60)
    assert.ok(await redis.client.ttl(`${prefix}:count`) > 0)
    assert.equal(await redis.set(`${prefix}:lock`, 'owner-a', { nx: true, ex: 60 }), 'OK')
    assert.equal(await redis.set(`${prefix}:lock`, 'owner-b', { nx: true, ex: 60 }), null)
    assert.equal(await redis.releaseLock(`${prefix}:lock`, 'owner-b'), 0)
    assert.equal(await redis.get(`${prefix}:lock`), 'owner-a')
    assert.equal(await redis.releaseLock(`${prefix}:lock`, 'owner-a'), 1)
    for (const sliding of [false, true]) {
      const limiter = createLimiter(redis, `${prefix}:${sliding}`, 5, 600000, sliding)
      const results = await Promise.all(Array.from({ length: 20 }, () => limiter.limit('same-client')))
      assert.equal(results.filter(result => result.success).length, 5)
      assert.equal((await limiter.limit('other-client')).success, true)
    }
  } finally {
    const keys = await redis.client.keys(`${prefix}:*`)
    if (keys.length) await redis.client.del(...keys)
    redis.client.disconnect()
  }
})

test('PostgreSQL TCP supports Drizzle results and transaction rollback', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 })
  const db = drizzle(pool)
  try {
    await db.execute(sql`create temporary table migration_driver_test (value integer not null)`)
    await assert.rejects(db.transaction(async tx => {
      await tx.execute(sql`insert into migration_driver_test values (1)`)
      throw new Error('rollback check')
    }), /rollback check/)
    const result = await db.execute(sql`select count(*)::int as count from migration_driver_test`)
    assert.equal(result.rows[0].count, 0)
  } finally {
    await pool.end()
  }
})
