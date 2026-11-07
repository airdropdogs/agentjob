import test from 'node:test'
import assert from 'node:assert/strict'
import { sandboxOrder, sandboxPaymentLink, sandboxReference, onrampOrigin } from './onramp-sandbox'

test('review orders always use sandbox identity, fixed Base USDC and synthetic contacts', () => {
  const wallet = '0x0000000000000000000000000000000000000001'
  const order = sandboxOrder('user@example.com', wallet, 'agent-job.ai')
  assert.match(order.partnerUserRef, /^sandbox-agentjob-/)
  assert.ok(!order.partnerUserRef.includes('user@example.com'))
  assert.equal(order.destinationAddress, wallet)
  assert.equal(order.destinationNetwork, 'base')
  assert.equal(order.purchaseCurrency, 'USDC')
  assert.equal(order.paymentAmount, '5.00')
  assert.equal(order.email, 'agentjob@sandbox.test')
  assert.notEqual(sandboxReference('first'), sandboxReference('second'))
  assert.throws(() => sandboxOrder('u', '0x' + '0'.repeat(40), 'agent-job.ai'))
})

test('payment links cannot load arbitrary domains or disable the simulated payment sheet', () => {
  assert.equal(new URL(sandboxPaymentLink('https://pay.coinbase.com/test?useApplePaySandbox=false')).searchParams.get('useApplePaySandbox'), 'true')
  for (const url of ['https://pay.coinbase.com.evil.test/x', 'http://pay.coinbase.com/x', 'javascript:alert(1)', 'https://attacker@pay.coinbase.com/x']) {
    assert.throws(() => sandboxPaymentLink(url))
  }
})

test('sandbox API only permits the configured exact origin, not missing or lookalike origins', () => {
  const old = process.env.ONRAMP_APP_ORIGIN
  process.env.ONRAMP_APP_ORIGIN = 'https://agent-job.ai'
  try {
    assert.equal(onrampOrigin(new Request('https://agent-job.ai/api', { headers: { Origin: 'https://agent-job.ai' } })), 'https://agent-job.ai')
    for (const origin of ['', 'https://agent-job.ai.evil.test', 'null', 'http://agent-job.ai']) {
      assert.equal(onrampOrigin(new Request('https://agent-job.ai/api', { headers: { Origin: origin } })), null)
    }
  } finally { if (old === undefined) delete process.env.ONRAMP_APP_ORIGIN; else process.env.ONRAMP_APP_ORIGIN = old }
})
