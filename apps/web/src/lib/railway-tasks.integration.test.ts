import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { users, agentProfiles, agentChatTasks, chats, messages, agentDailyStats } from '@agentjob/db'
import { hashApiKey } from './utils'

// Requires a migrated, disposable database. Never uses DATABASE_URL implicitly.
test('task polling, duplicate replies and repeated maintenance preserve single ownership', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.INTERNAL_API_SECRET = 'isolated-task-test'
  process.env.TASK_TIMEOUT_MINUTES = '30'
  const { getDb, getPool } = await import('./db')
  const { GET: poll } = await import('../app/api/agents/tasks/route')
  const { POST: respond } = await import('../app/api/agents/tasks/[taskId]/response/route')
  const { POST: expire } = await import('../app/api/internal/timeout-tasks/route')
  const db = getDb()
  const userId = randomUUID()
  const agentId = randomUUID()
  const chatId = randomUUID()
  const key = randomUUID()
  const headers = { authorization: `Bearer ${key}` }
  const maintenance = () => expire(new NextRequest('http://localhost/api/internal/timeout-tasks', {
    method: 'POST', headers: { 'x-internal-secret': 'isolated-task-test' },
  }))
  try {
    await db.insert(users).values({ id: userId, email: `${userId}@example.invalid` })
    await db.insert(agentProfiles).values({ id: agentId, userId, name: 'Isolated test',
      apiKeyHash: hashApiKey(key), priceFirstMsg: '0', priceSubsequent: '0' })
    await db.insert(chats).values({ id: chatId, userId, agentId })
    const [task] = await db.insert(agentChatTasks).values({ agentId, userId, chatId,
      messages: [{ role: 'user', content: 'test' }], amountUsdc: '0' }).returning()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const polls = await Promise.all([1, 2].map(() => poll(new NextRequest('http://localhost/api/agents/tasks?wait=5', {
      headers, signal: controller.signal,
    })).then(response => response.json())))
    clearTimeout(timer)
    assert.equal(polls.filter(result => result.task?.id === task.id).length, 1)

    // A fresh connection must not re-deliver a task already claimed by another poll.
    const reconnect = new AbortController()
    const reconnectTimer = setTimeout(() => reconnect.abort(), 3000)
    const reconnected = await poll(new NextRequest('http://localhost/api/agents/tasks?wait=5', {
      headers, signal: reconnect.signal,
    }))
    clearTimeout(reconnectTimer)
    assert.deepEqual(await reconnected.json(), { task: null })

    const responses = await Promise.all([1, 2].map(() => respond(new NextRequest('http://localhost/api/agents/tasks/response', {
      method: 'POST', headers, body: JSON.stringify({ text: 'only once' }),
    }), { params: Promise.resolve({ taskId: task.id }) })))
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 409])
    assert.equal((await db.select().from(messages).where(eq(messages.chatId, chatId))).length, 1)
    assert.equal((await db.select().from(agentProfiles).where(eq(agentProfiles.id, agentId)))[0].totalChats, 1)

    const [stale] = await db.insert(agentChatTasks).values({ agentId, userId, chatId,
      messages: [], amountUsdc: '0', createdAt: new Date(Date.now() - 86_400_000) }).returning()
    await Promise.all([maintenance(), maintenance()])
    await maintenance() // Retry after worker restart.
    assert.equal((await db.select().from(agentChatTasks).where(eq(agentChatTasks.id, stale.id)))[0].status, 'failed')
    assert.equal((await db.select().from(agentChatTasks).where(eq(agentChatTasks.id, task.id)))[0].status, 'completed')
    const [profile] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, agentId))
    assert.equal(profile.totalChats, 2)
    assert.equal(profile.noResponseCount, 1)
  } finally {
    await db.delete(messages).where(eq(messages.chatId, chatId))
    await db.delete(agentDailyStats).where(eq(agentDailyStats.agentId, agentId))
    await db.delete(agentChatTasks).where(eq(agentChatTasks.agentId, agentId))
    await db.delete(chats).where(eq(chats.id, chatId))
    await db.delete(agentProfiles).where(eq(agentProfiles.id, agentId))
    await db.delete(users).where(eq(users.id, userId))
    await getPool().end()
  }
})
