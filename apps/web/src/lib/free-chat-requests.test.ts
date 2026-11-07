import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { createFreeChatRequests, freeChatResponse, FreeChatRequestError } from './free-chat-requests'

const tables = ['platform_config', 'users', 'agent_profiles', 'chats', 'messages', 'agent_chat_tasks', 'user_agent_free_used', 'agent_daily_stats', 'user_daily_free_stats']
test('free requests atomically consume Agent allowances and replay from PostgreSQL', { skip: !process.env.TEST_FREE_CHAT_DATABASE_URL, timeout: 420000 }, async t => {
  const url = new URL(process.env.TEST_FREE_CHAT_DATABASE_URL!)
  assert.equal(url.pathname, '/agentjob_tests', 'Only isolated test database is allowed')
  const schema = `free_requests_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url.toString(), max: 1 })
  const pool = new Pool({ connectionString: url.toString(), max: 8, options: `-c search_path=${schema},public` })
  const api = createFreeChatRequests({ pool })
  const request = (userId: string, agentId: string, key = randomUUID(), chatId?: string) => ({ userId, agentId, idempotencyKey: key, requestedChatId: chatId, messages: [{ role: 'user', content: `Message ${key}` }] })
  async function user() {
    const id = randomUUID()
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [id, `${id}@example.invalid`])
    return id
  }
  async function agent(n = 3, daily = 100) {
    const owner = await user(), id = randomUUID()
    await pool.query("INSERT INTO agent_profiles(id,user_id,name,api_key_hash,price_first_msg,price_subsequent,free_messages_per_user,free_daily_max,max_concurrent_chats,last_heartbeat_at) VALUES($1,$2,'Isolated free test','test-only',0.01,0.01,$3,$4,100,now())", [id, owner, n, daily])
    return id
  }
  const configure = () => pool.query("INSERT INTO platform_config(key,value) VALUES('free_user_daily_limit','10000'),('agent_free_messages_per_user_max','100')")
  const reset = async () => { await pool.query(`TRUNCATE ${tables.join(',')},chat_free_requests CASCADE`); await configure() }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    for (const table of tables) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`)
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0005_agent_free_messages_per_user.sql'), 'utf8'))
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0006_chat_attachments.sql'), 'utf8'))
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0007_chat_deliveries.sql'), 'utf8'))
    await configure()
    await t.test('attachment metadata is durable and replay does not consume another free slot', async () => {
      const uid = await user(), aid = await agent()
      const attachments = [{ id: randomUUID(), name: 'sample.png', contentType: 'image/png', size: 64 }]
      const input = { ...request(uid, aid), messages: [{ role: 'user', content: 'Describe the image', attachments }] }
      const first = await api.consume(input), replay = await api.consume(input)
      assert.equal(first.taskId, replay.taskId)
      assert.deepEqual((await pool.query('SELECT attachments FROM messages')).rows[0].attachments, attachments)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n, 1)
      await reset()
    })
    await t.test('global daily cap serializes concurrent requests across different Agents; next UTC day resets only daily use', async () => {
      await pool.query("UPDATE platform_config SET value='2' WHERE key='free_user_daily_limit'")
      const uid = await user(), agents = await Promise.all(Array.from({ length: 5 }, () => agent(100)))
      const results = await Promise.all(agents.map(aid => api.consume(request(uid, aid))))
      assert.equal(results.filter(r => r.decision === 'free').length, 2)
      assert.equal((await pool.query('SELECT free_count FROM user_daily_free_stats WHERE user_id=$1', [uid])).rows[0].free_count, 2)
      await pool.query("UPDATE user_daily_free_stats SET stat_date=stat_date-1 WHERE user_id=$1", [uid])
      assert.equal((await api.consume(request(uid, agents[0]))).decision, 'free')
      assert.equal((await pool.query('SELECT sum(used_count)::int AS n FROM user_agent_free_used WHERE user_id=$1', [uid])).rows[0].n, 3)
      await reset()
    })
    await t.test('lowering platform Agent cap applies to existing allowances; zero daily cap closes free use', async () => {
      const uid = await user(), aid = await agent(100)
      await api.consume(request(uid, aid))
      await pool.query("UPDATE platform_config SET value='1' WHERE key='agent_free_messages_per_user_max'")
      assert.equal((await api.consume(request(uid, aid))).decision, 'paid')
      await pool.query("UPDATE platform_config SET value='3' WHERE key='agent_free_messages_per_user_max'")
      assert.equal((await api.consume(request(uid, aid))).decision, 'free')
      await pool.query("UPDATE platform_config SET value='0' WHERE key='free_user_daily_limit'")
      assert.equal((await api.consume(request(uid, aid))).decision, 'paid')
      assert.equal((await pool.query('SELECT used_count FROM user_agent_free_used WHERE user_id=$1', [uid])).rows[0].used_count, 2)
      await reset()
    })
    await t.test('five simultaneous different chats consume exactly N=3 across one user and Agent', async () => {
      const uid = await user(), aid = await agent(3)
      const results = await Promise.all(Array.from({ length: 5 }, () => api.consume(request(uid, aid))))
      assert.equal(results.filter(result => result.decision === 'free').length, 3)
      assert.equal(results.filter(result => result.decision === 'paid').length, 2)
      assert.equal((await pool.query('SELECT used_count FROM user_agent_free_used')).rows[0].used_count, 3)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_chat_tasks')).rows[0].n, 3)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM chats')).rows[0].n, 3)
      assert.equal((await pool.query('SELECT free_users_count FROM agent_daily_stats')).rows[0].free_users_count, 3)
      assert.equal((await pool.query('SELECT lifetime_free_count FROM users WHERE id=$1', [uid])).rows[0].lifetime_free_count, 3)
      await reset()
    })
    await t.test('same key replays one task even offline/busy, and mismatched content/chat/Agent conflicts', async () => {
      const uid = await user(), aid = await agent(1), req = request(uid, aid)
      const results = await Promise.all(Array.from({ length: 5 }, () => api.consume(req)))
      assert.equal(new Set(results.map(result => result.taskId)).size, 1)
      assert.equal((await pool.query('SELECT used_count FROM user_agent_free_used')).rows[0].used_count, 1)
      const first = results[0]
      await pool.query("UPDATE agent_profiles SET last_heartbeat_at=now()-interval '1 day',max_concurrent_chats=1 WHERE id=$1", [aid])
      assert.deepEqual(await api.consume(req), first)
      assert.equal(freeChatResponse((await api.get(req))!).status, 202)
      assert.deepEqual(await api.get({ ...req, requestedChatId: first.chatId }), first)
      const conflict = (error: unknown) => error instanceof FreeChatRequestError && error.status === 409
      await assert.rejects(api.get({ ...req, messages: [{ role: 'user', content: 'different' }] }), conflict)
      await assert.rejects(api.get({ ...req, requestedChatId: randomUUID() }), conflict)
      await assert.rejects(api.get({ ...req, agentId: randomUUID() }), conflict)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n, 1)
      await reset()
    })
    await t.test('Agent daily cap holds across concurrent different users', async () => {
      const aid = await agent(100, 2)
      const ids = await Promise.all(Array.from({ length: 5 }, user))
      const results = await Promise.all(ids.map(uid => api.consume(request(uid, aid))))
      assert.equal(results.filter(result => result.decision === 'free').length, 2)
      assert.equal((await pool.query('SELECT free_users_count FROM agent_daily_stats')).rows[0].free_users_count, 2)
      assert.equal((await pool.query('SELECT sum(lifetime_free_count)::int AS n FROM users')).rows[0].n, 2)
      await reset()
    })
    await t.test('N=100 honors configured daily allowance and ignores deprecated lifetime limit', async () => {
      const uid = await user(), aid = await agent(100)
      await pool.query('UPDATE users SET lifetime_free_count=20 WHERE id=$1', [uid])
      await pool.query("INSERT INTO user_daily_free_stats(user_id,stat_date,free_count) VALUES($1,(now() AT TIME ZONE 'UTC')::date,2)", [uid])
      const first = await api.consume(request(uid, aid))
      const second = await api.consume(request(uid, aid, randomUUID(), first.chatId))
      assert.equal(first.freeMessagesRemaining, 99)
      assert.equal(second.freeMessagesRemaining, 98)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM chats')).rows[0].n, 1)
      assert.equal((await pool.query('SELECT total_messages FROM chats')).rows[0].total_messages, 2)
      assert.equal((await pool.query('SELECT lifetime_free_count FROM users WHERE id=$1', [uid])).rows[0].lifetime_free_count, 22)
      assert.equal((await pool.query('SELECT free_count FROM user_daily_free_stats')).rows[0].free_count, 4)
      await reset()
    })
    await t.test('paid decisions consume no allowance and stay paid while new keys use an increased N', async () => {
      const uid = await user(), aid = await agent(1)
      await api.consume(request(uid, aid))
      const paidRequest = request(uid, aid)
      assert.equal((await api.consume(paidRequest)).decision, 'paid')
      await pool.query('UPDATE agent_profiles SET free_messages_per_user=3 WHERE id=$1', [aid])
      assert.equal((await api.consume(paidRequest)).decision, 'paid')
      assert.equal((await pool.query('SELECT used_count FROM user_agent_free_used')).rows[0].used_count, 1)
      assert.equal((await api.consume(request(uid, aid))).decision, 'free')
      await pool.query('UPDATE agent_profiles SET free_messages_per_user=1 WHERE id=$1', [aid])
      assert.equal((await api.consume(request(uid, aid))).decision, 'paid')
      assert.equal((await pool.query('SELECT used_count FROM user_agent_free_used')).rows[0].used_count, 2)
      await reset()
    })
    await t.test('failed task insert rolls back all counters, chat, message and request decision', async () => {
      const uid = await user(), aid = await agent(3), req = request(uid, aid)
      await pool.query("CREATE FUNCTION fail_free_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test task write failure'; END $$; CREATE TRIGGER fail_task BEFORE INSERT ON agent_chat_tasks FOR EACH ROW EXECUTE FUNCTION fail_free_task()")
      await assert.rejects(api.consume(req), /test task write failure/)
      for (const table of ['chats', 'messages', 'agent_chat_tasks', 'user_agent_free_used', 'agent_daily_stats', 'user_daily_free_stats', 'chat_free_requests']) {
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table} must roll back`)
      }
      assert.equal((await pool.query('SELECT lifetime_free_count FROM users WHERE id=$1', [uid])).rows[0].lifetime_free_count, 0)
      await pool.query('DROP TRIGGER fail_task ON agent_chat_tasks')
      assert.equal((await api.consume(req)).decision, 'free')
    })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
})

test('legacy free cache is verified and imported once, while durable replay never reads Redis', { skip: !process.env.TEST_FREE_CHAT_DATABASE_URL, timeout: 120000 }, async () => {
  const url = new URL(process.env.TEST_FREE_CHAT_DATABASE_URL!)
  assert.equal(url.pathname, '/agentjob_tests')
  const schema = `legacy_free_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url.toString(), max: 1 })
  const pool = new Pool({ connectionString: url.toString(), max: 3, options: `-c search_path=${schema},public` })
  const api = createFreeChatRequests({ pool })
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    for (const table of tables) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`)
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0005_agent_free_messages_per_user.sql'), 'utf8'))
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0006_chat_attachments.sql'), 'utf8'))
    const uid = randomUUID(), aid = randomUUID()
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [uid, `${uid}@example.invalid`])
    await pool.query("INSERT INTO agent_profiles(id,user_id,name,api_key_hash,price_first_msg,price_subsequent,free_messages_per_user,free_daily_max,max_concurrent_chats,last_heartbeat_at) VALUES($1,$2,'Legacy test','test-only',0.01,0.01,3,100,100,now())", [aid, uid])
    const req = { userId: uid, agentId: aid, idempotencyKey: randomUUID(), messages: [{ role: 'user', content: 'Legacy message' }] }
    const original = await api.consume(req)
    assert.equal((await api.restoreLegacy(req, async () => { assert.fail('PostgreSQL replay must not read Redis') }))?.taskId, original.taskId)
    await pool.query('DELETE FROM chat_free_requests WHERE user_id=$1 AND idempotency_key=$2', [uid, req.idempotencyKey])
    const oldCache = async () => ({ status: 202, body: JSON.stringify({ chat_id: original.chatId, is_free: true, status: 'pending' }) })
    const restored = await Promise.all(Array.from({ length: 3 }, () => api.restoreLegacy(req, oldCache)))
    assert.ok(restored.every(result => result?.taskId === original.taskId))
    assert.equal((await pool.query('SELECT used_count FROM user_agent_free_used')).rows[0].used_count, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_chat_tasks')).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_free_requests')).rows[0].n, 1)
    assert.equal((await api.restoreLegacy(req, async () => { throw Error('Redis offline') }))?.taskId, original.taskId)
    const unknown = { ...req, idempotencyKey: randomUUID() }
    assert.equal(await api.restoreLegacy(unknown, async () => null), null, 'Same content with a new uncached key is not a replay')
    await assert.rejects(api.restoreLegacy(unknown, async () => { throw Error('Redis offline') }), error => error instanceof FreeChatRequestError && error.status === 503)
    await assert.rejects(api.restoreLegacy({ ...unknown, messages: [{ role: 'user', content: 'Changed content' }] }, oldCache), error => error instanceof FreeChatRequestError && error.status === 409)
    await assert.rejects(api.restoreLegacy({ ...unknown, requestedChatId: randomUUID() }, oldCache), error => error instanceof FreeChatRequestError && error.status === 409)
    await assert.rejects(api.restoreLegacy(unknown, async () => ({ status: 202, body: JSON.stringify({ is_free: true, chat_id: randomUUID() }) })), error => error instanceof FreeChatRequestError && error.status === 503)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_chat_tasks')).rows[0].n, 1)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
})
