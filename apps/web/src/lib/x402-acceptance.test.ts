import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { verifyAcceptancePayment, settleAcceptancePayment, type X402PaymentRequest } from './x402'

const payer = '0x0000000000000000000000000000000000000001'
const recipient = '0x0000000000000000000000000000000000000002'
const requirements = { scheme: 'exact' as const, network: 'base', maxAmountRequired: '5000', resource: 'https://example.test/api/chat', description: 'test', mimeType: 'application/json', payTo: recipient, maxTimeoutSeconds: 300, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }
const request = (authorization = { from: payer, to: recipient, value: '5000' }): X402PaymentRequest => ({
  paymentHeader: Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0x00', authorization } })).toString('base64'),
  paymentRequirements: requirements, agentWallet: recipient, amountUsdc: 0.005, platformFeeRate: 0,
})

test('acceptance rejects wrong payer, recipient and amount before facilitator access', async () => {
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network access') }
  try {
    assert.equal(await verifyAcceptancePayment(request({ from: recipient, to: recipient, value: '5000' }), payer), false)
    assert.equal(await verifyAcceptancePayment(request({ from: payer, to: payer, value: '5000' }), payer), false)
    assert.equal(await verifyAcceptancePayment(request({ from: payer, to: recipient, value: '5001' }), payer), false)
    assert.equal(calls, 0)
  } finally { globalThis.fetch = previous }
})

test('facilitator verification must explicitly match payer; settlement requires a valid receipt', async () => {
  const saved = { fetch: globalThis.fetch, id: process.env.CDP_API_KEY_ID, secret: process.env.CDP_API_KEY_SECRET }
  // Ephemeral test-only key signs local HTTP authentication; fetch is always mocked.
  process.env.CDP_API_KEY_ID = 'organizations/test/apiKeys/test'
  process.env.CDP_API_KEY_SECRET = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  let reply: unknown = { isValid: true }
  const calls: string[] = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    const body = JSON.parse(String(init?.body))
    assert.equal(body.paymentRequirements.maxAmountRequired, '5000')
    assert.equal(body.paymentRequirements.payTo, recipient)
    assert.ok(init?.signal)
    return Response.json(reply)
  }
  try {
    assert.equal(await verifyAcceptancePayment(request(), payer), false)
    reply = { isValid: true, payer: recipient }
    assert.equal(await verifyAcceptancePayment(request(), payer), false)
    reply = { isValid: true, payer }
    assert.equal(await verifyAcceptancePayment(request(), payer), true)
    reply = { isValid: 'false', payer }
    assert.equal(await verifyAcceptancePayment(request(), payer), false)
    assert.equal(calls.every(url => url.endsWith('/verify')), true)
    reply = { success: true }
    await assert.rejects(settleAcceptancePayment(request()), /reconciliation/)
    reply = { success: false, transaction: `0x${'a'.repeat(64)}` }
    await assert.rejects(settleAcceptancePayment(request()), /reconciliation/)
    reply = { success: 'false', transaction: `0x${'a'.repeat(64)}` }
    await assert.rejects(settleAcceptancePayment(request()), /reconciliation/)
    reply = { success: true, transaction: `0x${'a'.repeat(64)}` }
    assert.deepEqual(await settleAcceptancePayment(request()), { transaction: `0x${'a'.repeat(64)}` })
    globalThis.fetch = async () => { throw new Error('connection lost after submit') }
    await assert.rejects(settleAcceptancePayment(request()), /connection lost/)
  } finally {
    globalThis.fetch = saved.fetch
    for (const [key, value] of [['CDP_API_KEY_ID', saved.id], ['CDP_API_KEY_SECRET', saved.secret]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
