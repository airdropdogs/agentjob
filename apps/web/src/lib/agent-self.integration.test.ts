import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { users, agentProfiles } from '@agentjob/db'
import { hashApiKey } from './utils'

test('unknown agent endpoint names return 404 before touching the database', async () => {
  const { GET } = await import('../app/api/agents/[id]/route')
  for (const id of ['profile', 'status', 'not-a-uuid', '0x1234']) {
    const response = await GET(new NextRequest(`https://agent-job.ai/api/agents/${id}`), {
      params: Promise.resolve({ id }),
    })
    assert.equal(response.status, 404)
  }
})

test('provider self lookup authenticates Bearer and public responses exclude key hashes', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  const { getDb, getPool } = await import('./db')
  const { GET: self } = await import('../app/api/agents/me/route')
  const { GET: detail } = await import('../app/api/agents/[id]/route')
  const { GET: list } = await import('../app/api/agents/route')
  const db = getDb()
  const userId = randomUUID(), agentId = randomUUID(), key = randomUUID()
  const wallet = `0x${randomUUID().replaceAll('-', '')}00000000`
  const request = (authorization: string) => new Request('https://agent-job.ai/api/agents/me', {
    headers: { authorization },
  })
  try {
    await db.insert(users).values({ id: userId, email: `${userId}@example.invalid`, wallet })
    await db.insert(agentProfiles).values({ id: agentId, userId, name: 'Provider self test',
      apiKeyHash: hashApiKey(key), priceFirstMsg: '0', priceSubsequent: '0',
      onlineStatus: 'online', lastHeartbeatAt: new Date() })
    for (const authorization of ['Bearer wrong-key', 'Bearer ', 'Basic incorrect']) {
      assert.equal((await self(request(authorization))).status, 401)
    }
    const response = await self(request(`Bearer ${key}`))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, data: {
      id: agentId, name: 'Provider self test', online: true,
      profileUrl: `https://agent-job.ai/agents/${agentId}`,
      chatUrl: `https://agent-job.ai/chat/${wallet}`,
    } })
    await db.update(agentProfiles).set({ lastHeartbeatAt: new Date(Date.now() - 300_000) }).where(eq(agentProfiles.id, agentId))
    assert.equal((await (await self(request(`Bearer ${key}`))).json()).data.online, false)
    await db.update(users).set({ wallet: null }).where(eq(users.id, userId))
    assert.equal((await (await self(request(`Bearer ${key}`))).json()).data.chatUrl, null)

    const publicDetail = await (await detail(new NextRequest(`https://agent-job.ai/api/agents/${agentId}`), {
      params: Promise.resolve({ id: agentId }),
    })).json()
    assert.equal(publicDetail.data.id, agentId)
    assert.equal(Object.hasOwn(publicDetail.data, 'apiKeyHash'), false)
    const publicList = await (await list(new NextRequest('https://agent-job.ai/api/agents?sort=newest&status=online,busy,offline'))).json()
    assert.ok(publicList.data.agents.some((agent: { id: string }) => agent.id === agentId))
    for (const agent of publicList.data.agents) assert.equal(Object.hasOwn(agent, 'apiKeyHash'), false)
  } finally {
    await db.delete(agentProfiles).where(eq(agentProfiles.id, agentId))
    await db.delete(users).where(eq(users.id, userId))
    await getPool().end()
  }
})
