import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHAT_PAYMENT_POLICY, usdcMicro, validChatPaymentPolicy, validChatPaymentSetting } from './chat-payment-policy'
import { assertChatPaymentAcceptanceAllowed } from './chat-payment-acceptance'

test('Admin payment settings reject fractional micro-USDC, non-finite values and inconsistent budgets', () => {
  assert.equal(usdcMicro('0.000001'), 1)
  for (const value of ['', 'NaN', '-1', '0', '0.0000001', '1e2', '100.000001']) {
    assert.equal(validChatPaymentSetting('chat_max_message_usdc', value), false, value)
  }
  assert.equal(validChatPaymentSetting('chat_max_authorization_usdc', '1000'), true)
  assert.equal(validChatPaymentSetting('chat_max_authorization_usdc', '1000.000001'), false)
  assert.equal(validChatPaymentSetting('chat_payments_enabled', 'yes'), false)
  assert.equal(validChatPaymentSetting('chat_authorization_minutes', '0'), false)
  assert.equal(validChatPaymentSetting('chat_authorization_minutes', '1441'), false)
  assert.equal(validChatPaymentPolicy(DEFAULT_CHAT_PAYMENT_POLICY), true)
  assert.equal(validChatPaymentPolicy({ ...DEFAULT_CHAT_PAYMENT_POLICY, chatMaxAuthorizationUsdc: 1 }), false)
})

test('Admin switch and per-message maximum apply independently of retired acceptance variables', () => {
  const intent = { userId: 'user', agentId: 'agent', payer: 'payer', platformRecipient: 'platform', agentRecipient: 'agent', totalMicro: 2_000_000 }
  assert.doesNotThrow(() => assertChatPaymentAcceptanceAllowed(intent, { CHAT_PAYMENT_ACCEPTANCE_MAX_INTENT_MICRO: '100000' }))
  assert.throws(() => assertChatPaymentAcceptanceAllowed(intent, {}, { ...DEFAULT_CHAT_PAYMENT_POLICY, chatPaymentsEnabled: false }), /acceptance_disabled/)
  assert.throws(() => assertChatPaymentAcceptanceAllowed(intent, {}, { ...DEFAULT_CHAT_PAYMENT_POLICY, chatMaxMessageUsdc: 1 }), /acceptance_intent_limit/)
  assert.throws(() => assertChatPaymentAcceptanceAllowed(intent, { ENABLE_CHAT_PAYMENT_ACCEPTANCE: 'false' }), /acceptance_disabled/)
})
