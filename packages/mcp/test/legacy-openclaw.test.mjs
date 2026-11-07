import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readConfig, runConnector } from '../../../apps/web/public/agentjob-openclaw.mjs'

test('reject remote Gateway and URL credentials', () => {
  const env = { AGENTJOB_API_KEY: 'platform-secret', OPENCLAW_GATEWAY_TOKEN: 'gateway-secret', OPENCLAW_AGENT_ID: 'marketplace' }
  assert.equal(readConfig(env).agentId, 'marketplace')
  assert.throws(() => readConfig({ ...env, OPENCLAW_GATEWAY_URL: 'http://example.com/v1/chat/completions' }))
  assert.throws(() => readConfig({ ...env, AGENTJOB_BASE_URL: 'https://secret@example.com' }))
  assert.throws(() => readConfig({ ...env, OPENCLAW_AGENT_ID: '' }))
})

test('real HTTP: response retry does not repeat inference; duplicate claim and failed inference never rerun', async () => {
  const controller = new AbortController()
  let polls = 0, inferences = 0, submissions = 0
  const logs = [], submitted = []
  const server = createServer(async (req, res) => {
    const body = []
    for await (const part of req) body.push(part)
    const json = body.length ? JSON.parse(Buffer.concat(body).toString()) : null
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/chat/completions') {
      assert.equal(req.headers.authorization, 'Bearer gateway-secret')
      assert.equal(json.model, 'openclaw:marketplace')
      assert.equal(json.user, undefined)
      assert.equal(req.headers['x-openclaw-session-key'], undefined)
      inferences++
      if (inferences === 2) { res.statusCode = 500; res.end('{"error":"gateway-secret"}'); return }
      res.end(JSON.stringify({ choices: [{ message: { content: 'answer' } }] })); return
    }
    assert.equal(req.headers.authorization, 'Bearer platform-secret')
    if (req.url === '/api/agents/heartbeat') { res.end('{"ok":true}'); return }
    if (req.url.startsWith('/api/agents/tasks?')) {
      polls++
      if (polls === 5) { controller.abort(); res.end('{"task":null}'); return }
      res.end(JSON.stringify({ task: { id: polls <= 2 ? 'one' : 'two', messages: [{ role: 'user', content: 'hello' }] } })); return
    }
    submissions++; submitted.push(json)
    res.statusCode = submissions === 1 ? 503 : 200
    res.end('{"submitted":true}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await runConnector(readConfig({ AGENTJOB_BASE_URL: base, OPENCLAW_GATEWAY_URL: `${base}/v1/chat/completions`,
      AGENTJOB_API_KEY: 'platform-secret', OPENCLAW_GATEWAY_TOKEN: 'gateway-secret', OPENCLAW_AGENT_ID: 'marketplace' }),
    { signal: controller.signal, retryMs: 1, log: line => logs.push(line) })
    assert.equal(inferences, 2)
    assert.equal(submissions, 2)
    assert.deepEqual(submitted, [{ text: 'answer' }, { text: 'answer' }])
    assert.ok(!logs.join('').includes('secret'))
  } finally { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('inference timeout aborts and never submits a fabricated response', async () => {
  const controller = new AbortController()
  let inferences = 0, polls = 0, submitted = false
  await runConnector({ platform: 'http://localhost', gateway: 'http://localhost/v1/chat/completions', apiKey: 'a', token: 'b', agentId: 'isolated' }, {
    signal: controller.signal, retryMs: 1, inferenceTimeoutMs: 10, log() {},
    async fetchImpl(url, options) {
      if (url.endsWith('/heartbeat')) return Response.json({ ok: true })
      if (url.includes('?wait=')) {
        if (++polls > 1) controller.abort()
        return Response.json({ task: { id: 'timeout', messages: [{ role: 'user', content: 'hi' }] } })
      }
      if (url.endsWith('/response')) { submitted = true; return Response.json({}) }
      inferences++
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('secret')), { once: true }))
    },
  })
  assert.equal(inferences, 1)
  assert.equal(submitted, false)
})
