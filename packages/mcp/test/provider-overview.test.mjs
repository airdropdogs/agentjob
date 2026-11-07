import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../../../apps/web/src/app/api/agents/me/overview/route.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText

function setup({ authorized = true, banned = false, rpcError = false, limited = false } = {}) {
  const filters = [], calls = []
  const wallet = '0x' + '1'.repeat(40)
  const schema = Object.fromEntries(['agentProfiles', 'users', 'chats', 'payments'].map(table => [table, new Proxy({}, { get: (_, key) => `${table}.${String(key)}` })]))
  const db = { select(fields) {
    const rows = 'wallet' in fields ? [{ wallet, bannedAt: banned ? new Date() : null }] : 'users' in fields ? [{ users: 3, conversations: 5 }] : [{ usdc: '0.180000' }]
    const chain = { from() { return chain }, innerJoin() { return chain }, where(filter) { filters.push(filter); return chain }, limit() { return Promise.resolve(rows) }, then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject) } }
    return chain
  } }
  const json = (data, status = 200) => Response.json(data, { status })
  const imports = {
    '@/lib/db': { getDb: () => db },
    '@/lib/agent-auth': { verifyAgentApiKey: async () => authorized ? { id: 'own-agent', name: 'test', lastHeartbeatAt: new Date() } : null, isAgentOnlineByHeartbeat: () => true },
    '@/lib/api-response': { ok: data => json({ ok: true, data }), err: (message, status) => json({ error: message }, status), unauthorized: () => json({}, 401) },
    '@/lib/rate-limit': { apiKeyRateLimit: { limit: async () => ({ success: !limited }) } },
    '@agentjob/db': schema,
    'drizzle-orm': Object.fromEntries(['and', 'eq', 'gte', 'lt', 'sql'].map(op => [op, (...args) => ({ op, args })])),
  }
  const exports = {}
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-01T12:00:00Z'])) } }
  vm.runInNewContext(compiled, { exports, require: name => { if (!(name in imports)) throw new Error(name); return imports[name] }, Date: FixedDate, BigInt, AbortSignal,
    fetch: async (url, options) => { calls.push({ url, options }); return json(rpcError ? { error: { message: 'RPC failed' } } : { result: '0x12d687' }) },
  })
  return { GET: exports.GET, filters, calls, wallet }
}

test('overview rejects unauthenticated, banned and rate-limited callers without RPC', async () => {
  for (const [options, status] of [[{ authorized: false }, 401], [{ banned: true }, 401], [{ limited: true }, 429]]) {
    const state = setup(options)
    assert.equal((await state.GET(new Request('https://agent-job.ai/api/agents/me/overview'))).status, status)
    assert.equal(state.calls.length, 0)
  }
})

test('overview scopes queries to provider, reports UTC week and exact USDC balance', async () => {
  const state = setup()
  const { data } = await (await state.GET(new Request('https://agent-job.ai/api/agents/me/overview'))).json()
  assert.equal(data.walletAddress, state.wallet)
  assert.equal(data.walletBalance.usdc, '1.234567')
  assert.equal(data.week.start, '2026-10-26T00:00:00.000Z')
  assert.equal(data.week.recordedAgentReceiptsUsdc, '0.180000')
  assert.equal(data.inquiries.uniqueUsers, 3)
  assert.equal(data.inquiries.conversations, 5)
  const predicates = JSON.stringify(state.filters)
  assert.match(predicates, /payments.status.*success/)
  assert.equal((predicates.match(/own-agent/g) ?? []).length, 3)
  assert.match(predicates, /payments.createdAt/)
  assert.equal(JSON.parse(state.calls[0].options.body).method, 'eth_call')
})

test('RPC error preserves statistics but never reports zero balance', async () => {
  const state = setup({ rpcError: true })
  const { data } = await (await state.GET(new Request('https://agent-job.ai/api/agents/me/overview'))).json()
  assert.equal(data.walletBalance.status, 'unavailable')
  assert.equal(data.walletBalance.usdc, null)
  assert.equal(data.inquiries.uniqueUsers, 3)
})
