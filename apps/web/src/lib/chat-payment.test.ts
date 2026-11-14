import test from 'node:test'
import assert from 'node:assert/strict'
import { readPaymentQuote, samePaymentQuote, submitChatPayment, type PaymentPhase, type PaymentQuote, paymentScope, createPaymentGrant, grantMatches, reserveMessage, quoteMatchesScope } from './chat-payment'

const recipient = '0x1111111111111111111111111111111111111111'
const required = (amount = '5000', extra = {}) => Response.json({ accepts: [{ scheme: 'exact', network: 'base',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: recipient, maxAmountRequired: amount, ...extra }] }, { status: 402 })

test('free task response never starts the second payment phase or invokes a signer', async () => {
  const phases: string[] = []
  const result = await submitChatPayment({ quotes: {}, request: async phase => {
    phases.push(phase); return Response.json({ task_id: 'free-task' }, { status: 202 })
  }, confirm: async () => { throw new Error('unexpected confirmation') }, pay: async () => { throw new Error('unexpected signing') } })
  assert.equal(result.status, 202)
  assert.deepEqual(phases, ['platform_fee'])
})

test('each paid phase checks authorization; retry reuses paid platform phase', async () => {
  const quotes: Partial<Record<PaymentPhase, PaymentQuote>> = {}
  let feePaid = false
  let rejectAgent = true
  const confirmations: PaymentPhase[] = [], signatures: PaymentPhase[] = []
  const options = { quotes,
    request: async (phase: PaymentPhase) => phase === 'platform_fee' && feePaid ? Response.json({ ok: true }) : required(phase === 'platform_fee' ? '5000' : '95000'),
    confirm: async (phase: PaymentPhase) => { confirmations.push(phase); return true },
    pay: async (phase: PaymentPhase) => {
      signatures.push(phase)
      if (phase === 'platform_fee') { feePaid = true; return Response.json({ ok: true }) }
      if (rejectAgent) { rejectAgent = false; throw new Error('network unavailable') }
      return Response.json({ task_id: 'paid-task' }, { status: 202 })
    },
  }
  await assert.rejects(submitChatPayment(options), /network unavailable/)
  assert.equal((await submitChatPayment(options)).status, 202)
  assert.deepEqual(confirmations, ['platform_fee', 'agent', 'agent'])
  assert.deepEqual(signatures, ['platform_fee', 'agent', 'agent'])
})

test('cancelled confirmation does not sign; unsupported assets and limits are rejected', async () => {
  let signed = false
  await assert.rejects(submitChatPayment({ quotes: {}, request: async () => required(), confirm: async () => false,
    pay: async () => { signed = true; return new Response() } }), /cancelled/)
  assert.equal(signed, false)
  for (const response of [required('100000001'), required('0'), required('100', { network: 'base-sepolia' }), required('100', { asset: recipient })]) {
    await assert.rejects(readPaymentQuote(response), /Base USDC/)
  }
  const quote = await readPaymentQuote(required())
  assert.equal(samePaymentQuote(quote, { ...quote, amount: '6000' }), false)
  assert.equal(samePaymentQuote(quote, { ...quote, payTo: '0x2222222222222222222222222222222222222222' }), false)
})

test('combined stage amounts cannot exceed the per-message cap', async () => {
  const quotes = { platform_fee: await readPaymentQuote(required('99910000')) }
  await assert.rejects(submitChatPayment({ quotes,
    request: async phase => phase === 'platform_fee' ? Response.json({ ok: true }) : required('95000'),
    confirm: async () => { throw new Error('must reject before confirmation') },
    pay: async () => { throw new Error('must not sign') },
  }), /Total payment exceeds/)
})

const eligibility = { eligible: false, reason: 'already_used', paymentEnabled: true, payer: recipient, priceMicro: '100000',
  platformFeeMicro: '5000', agentMicro: '95000', platformRecipient: recipient, agentRecipient: recipient, remainingBudgetMicro: '1000000' }

test('one authorization covers both phases and reserves a message only once across retries', async () => {
  const scope = paymentScope('agent-one', recipient, eligibility)
  const grant = createPaymentGrant(scope, eligibility.remainingBudgetMicro, 1000)
  reserveMessage(grant, 'same-message', '1000000', 1001)
  reserveMessage(grant, 'same-message', '0', 1002)
  assert.deepEqual(grant.reserved, { 'same-message': '100000' })
  assert.equal(quoteMatchesScope('platform_fee', await readPaymentQuote(required('5000')), scope), true)
  assert.equal(quoteMatchesScope('agent', await readPaymentQuote(required('95000')), scope), true)
  for (let i = 0; i < 9; i++) reserveMessage(grant, `message-${i}`, '1000000', 1003)
  assert.throws(() => reserveMessage(grant, 'over-budget', '1000000', 1004), /budget exhausted/)
  // No release operation exists: errors retain reservations conservatively.
  assert.equal(Object.keys(grant.reserved).length, 10)
})

test('revocation, expiration, different Agent, payer, price or recipient invalidate authorization', () => {
  const scope = paymentScope('agent-one', recipient, eligibility)
  const grant = createPaymentGrant(scope, '1000000', 1000)
  assert.equal(grantMatches(grant, scope, 1001), true)
  assert.equal(grantMatches(null, scope, 1001), false)
  assert.equal(grantMatches(grant, scope, 3_601_000), false)
  for (const change of [{ agentId: 'agent-two' }, { payer: '0x2222222222222222222222222222222222222222' },
    { priceMicro: '99999' }, { platformRecipient: '0x2222222222222222222222222222222222222222' },
    { agentRecipient: '0x2222222222222222222222222222222222222222' }]) {
    assert.equal(grantMatches(grant, { ...scope, ...change }, 1001), false)
  }
  assert.throws(() => reserveMessage(grant, 'expired', '1000000', 3_601_000), /expired/)
  assert.throws(() => paymentScope('agent-one', '0x2222222222222222222222222222222222222222', eligibility), /wallet does not match/)
})

test('authorization enforces configured maximum and rejects zero budgets', () => {
  const scope = paymentScope('agent-one', recipient, eligibility)
  const grant = createPaymentGrant(scope, '100000', 1000)
  reserveMessage(grant, 'last-message', '100000', 1001)
  assert.throws(() => reserveMessage(grant, 'another-message', '100000', 1002), /budget exhausted/)
  assert.throws(() => createPaymentGrant(scope, '0', 1003), /budget/)
})

test('numeric eligibility API fields normalize to exact x402 quote amounts', async () => {
  const scope = paymentScope('agent-one', recipient, { ...eligibility,
    priceMicro: 100000, platformFeeMicro: 5000, agentMicro: 95000, remainingBudgetMicro: 1000000 })
  assert.equal(scope.priceMicro, '100000')
  assert.equal(quoteMatchesScope('platform_fee', await readPaymentQuote(required('5000')), scope), true)
  assert.equal(quoteMatchesScope('agent', await readPaymentQuote(required('95000')), scope), true)
})

test('users choose a renewable budget within Admin limits and configured expiry', () => {
  const scope = paymentScope('agent-one', recipient, eligibility)
  const grant = createPaymentGrant(scope, '100000000', 1000, '2000000', 15)
  assert.equal(grant.budgetMicro, '2000000')
  assert.equal(grant.expiresAt, 901000)
  for (let i = 0; i < 20; i++) reserveMessage(grant, `message-${i}`, '100000000', 1001)
  assert.throws(() => reserveMessage(grant, 'exhausted', '100000000', 1002), /exhausted/)
  const renewed = createPaymentGrant(scope, '100000000', 1003, '1000000', 15)
  assert.doesNotThrow(() => reserveMessage(renewed, 'new-message', '100000000', 1004))
  assert.throws(() => createPaymentGrant(scope, '1000000', 1000, '2000000'), /budget/)
  assert.throws(() => createPaymentGrant(scope, '1000000', 1000, '50000'), /budget/)
  assert.throws(() => createPaymentGrant(scope, '1000000', 1000, '100000', 1441), /expiry/)
})

test('one budget authorization covers phases and messages; expiration and changed prices require reauthorization', async () => {
  let grant: ReturnType<typeof createPaymentGrant> | null = null
  let dialogs = 0
  let signatures = 0
  async function runMessage(key: string, scope: ReturnType<typeof paymentScope>, free = false) {
    const result = await submitChatPayment({ quotes: {},
      request: async phase => free ? Response.json({}, { status: 202 }) : required(phase === 'platform_fee' ? scope.platformFeeMicro : scope.agentMicro),
      confirm: async (phase, quote) => {
        assert.ok(quoteMatchesScope(phase, quote, scope))
        if (!grantMatches(grant, scope)) { dialogs++; grant = createPaymentGrant(scope, '1000000') }
        reserveMessage(grant!, key, '1000000')
        return true
      },
      pay: async phase => { signatures++; return Response.json({}, { status: phase === 'platform_fee' ? 200 : 202 }) },
    })
    assert.equal(result.status, 202)
  }
  const scope = paymentScope('agent-one', recipient, eligibility)
  await runMessage('free', scope, true)
  assert.equal(dialogs, 0)
  assert.equal(signatures, 0)
  await runMessage('first', scope)
  await runMessage('second', scope)
  assert.equal(dialogs, 1)
  assert.equal(signatures, 4)
  if (grant) (grant as ReturnType<typeof createPaymentGrant>).expiresAt = Date.now() - 1
  await runMessage('expired', scope)
  assert.equal(dialogs, 2)
  const changed = paymentScope('agent-one', recipient, { ...eligibility, priceMicro: '90000', platformFeeMicro: '4500', agentMicro: '85500' })
  await runMessage('changed-price', changed)
  assert.equal(dialogs, 3)
  assert.equal(signatures, 8)
})
