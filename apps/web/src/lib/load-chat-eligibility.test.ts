import test from 'node:test'
import assert from 'node:assert/strict'
import { loadChatEligibility } from './load-chat-eligibility'

test('free and paid responses stay distinct; requests include cookies and a timeout', async () => {
  for (const eligible of [true, false]) {
    const result = await loadChatEligibility(new URLSearchParams({ agent_id: 'test-agent' }), async (_, init) => {
      assert.equal(init?.credentials, 'same-origin')
      assert.ok(init?.signal)
      return Response.json({ eligible, priceMicro: 10000 })
    })
    assert.equal(result.eligible, eligible)
  }
})

test('failed and unknown eligibility are retryable errors, not successful null results', async () => {
  for (const status of [401, 404, 503]) {
    await assert.rejects(loadChatEligibility(new URLSearchParams(), async () => new Response(null, { status })), new RegExp(`PRICE_CHECK_HTTP_${status}`))
  }
  await assert.rejects(loadChatEligibility(new URLSearchParams(), async () => Response.json({ eligible: null })), /PRICE_CHECK_UNAVAILABLE/)
})
