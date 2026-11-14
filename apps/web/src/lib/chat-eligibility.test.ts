import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceQuote, chatEligibilityOwnershipStatus, evaluateChatFreeEligibility, type FreeEligibilityState } from './chat-eligibility'
import { assertChatPaymentAcceptanceAllowed, type AcceptanceIntent } from './chat-payment-acceptance'
import { validFreeChatLimit } from './free-chat-policy'

const first: FreeEligibilityState = { existingChat: false, userAgentUsedCount: 0, freeMessagesPerUser: 1, userExists: true, banned: false, agentUsed: 0, agentLimit: 20 }

test('global daily limit and platform Agent allowance cap both apply without resetting usage', () => {
  const state = { ...first, freeMessagesPerUser: 100, agentFreeMessagesPerUserMax: 5, userDailyLimit: 10, userDailyUsed: 9 }
  assert.equal(evaluateChatFreeEligibility(state).freeMessagesRemaining, 1)
  assert.equal(evaluateChatFreeEligibility({ ...state, userDailyUsed: 10 }).reason, 'user_daily_limit')
  assert.equal(evaluateChatFreeEligibility({ ...state, userDailyLimit: 0 }).eligible, false)
  assert.equal(evaluateChatFreeEligibility({ ...state, userAgentUsedCount: 5 }).reason, 'agent_free_used')
  assert.equal(evaluateChatFreeEligibility({ ...state, userDailyUsed: 0 }).freeMessagesRemaining, 5)
  assert.equal(evaluateChatFreeEligibility({ ...state, agentUsed: 20 }).freeMessagesRemaining, 0)
  assert.equal(evaluateChatFreeEligibility({ ...state, agentUsed: 5 }).reason, 'agent_daily_limit')
  assert.equal(evaluateChatFreeEligibility({ ...state, agentUsed: 4, userDailyUsed: 0 }).freeMessagesRemaining, 1)
})

test('admin free quotas reject fractional, negative, empty and out-of-range values', () => {
  for (const value of ['0', '2', '10000']) assert.equal(validFreeChatLimit('free_user_daily_limit', value), true)
  for (const value of ['1', '100']) assert.equal(validFreeChatLimit('agent_free_messages_per_user_max', value), true)
  for (const key of ['free_user_daily_limit', 'agent_free_messages_per_user_max']) {
    for (const value of ['', '-1', '2.5', 'NaN', 'Infinity', '10001', '1e2']) assert.equal(validFreeChatLimit(key, value), false)
  }
  assert.equal(validFreeChatLimit('agent_free_messages_per_user_max', '0'), false)
  assert.equal(validFreeChatLimit('agent_free_messages_per_user_max', '101'), false)
})

test('GET and POST conceal chats owned by a different user or agent with 404', () => {
  assert.equal(chatEligibilityOwnershipStatus({ userId: 'other', agentId: 'agent' }, 'owner', 'agent'), 404)
  assert.equal(chatEligibilityOwnershipStatus({ userId: 'owner', agentId: 'other-agent' }, 'owner', 'agent'), 404)
  assert.equal(chatEligibilityOwnershipStatus({ userId: 'owner', agentId: 'agent' }, 'owner', 'agent'), 200)
  assert.equal(chatEligibilityOwnershipStatus(null, 'owner', 'agent'), 200)
})

test('free eligibility is per user/agent, not per newly created chat', () => {
  assert.equal(evaluateChatFreeEligibility(first).eligible, true)
  assert.equal(evaluateChatFreeEligibility({ ...first, userAgentUsedCount: 1 }).reason, 'agent_free_used')
  assert.equal(evaluateChatFreeEligibility({ ...first, existingChat: true }).eligible, true)
  for (const change of [{ agentLimit: 0 }, { agentUsed: 20 }, { userExists: false }, { banned: true }]) {
    assert.equal(evaluateChatFreeEligibility({ ...first, ...change }).eligible, false)
  }
})

test('configurable per-user allowance accumulates across chats and changing allowance preserves usage', () => {
  for (const existingChat of [true, false]) {
    const result = evaluateChatFreeEligibility({ ...first, existingChat, userAgentUsedCount: 2, freeMessagesPerUser: 3 })
    assert.equal(result.eligible, true)
    assert.equal(result.freeMessagesRemaining, 1)
    assert.equal(evaluateChatFreeEligibility({ ...first, existingChat, userAgentUsedCount: 3, freeMessagesPerUser: 3 }).eligible, false)
  }
  assert.equal(evaluateChatFreeEligibility({ ...first, userAgentUsedCount: 5, freeMessagesPerUser: 1 }).freeMessagesRemaining, 0)
  assert.equal(evaluateChatFreeEligibility({ ...first, userAgentUsedCount: 5, freeMessagesPerUser: 7 }).freeMessagesRemaining, 2)
  const legacyGlobalExhausted = { ...first, freeMessagesPerUser: 100, userDailyUsed: 2, userDailyLimit: 2, userLifetimeUsed: 20, userLifetimeLimit: 20 }
  assert.equal(evaluateChatFreeEligibility(legacyGlobalExhausted).reason, 'user_daily_limit')
})

const intent: AcceptanceIntent = {
  id: 'intent', userId: 'owner', agentId: 'agent', chatId: 'chat', idempotencyKey: 'key', messagesHash: 'hash',
  payer: 'payer', platformRecipient: 'platform', agentRecipient: 'recipient',
  totalMicro: 50000, platformFeeMicro: 2500, agentMicro: 47500,
  platformStatus: 'settled', agentStatus: 'pending', taskId: null, receipts: [], delivery: null,
}
const input = { intent, userId: 'owner', agentId: 'agent', chatId: 'chat', priceMicro: 99999, platformFeeMicro: 999, platformRecipient: 'new-platform', agentRecipient: 'new-recipient', payer: 'payer', authorizationMaxMicro: 100_000_000 }

test('last reserved intent remains resumable with frozen quote and cannot cross identity boundaries', () => {
  const quote = acceptanceQuote(input)
  assert.equal(quote.priceMicro, 50000)
  assert.equal(quote.platformFeeMicro, 2500)
  assert.equal(quote.platformRecipient, 'platform')
  assert.equal(quote.agentRecipient, 'recipient')
  assert.equal(quote.remainingBudgetMicro, 100_000_000)
  assert.equal(quote.reservedIntentMicro, 50000)
  assert.equal(acceptanceQuote({ ...input, intent: { ...intent, taskId: 'done' } }).remainingBudgetMicro, 100_000_000)
  for (const change of [{ userId: 'other' }, { agentId: 'other' }, { chatId: 'other' }]) {
    assert.throws(() => acceptanceQuote({ ...input, ...change }), /intent_mismatch/)
  }
})

test('paid chat permits users and Agents outside the former trial whitelist', () => {
  const env = { NODE_ENV: 'test' as const, ENABLE_CHAT_PAYMENT_ACCEPTANCE: 'true', CHAT_PAYMENT_ACCEPTANCE_USER_IDS: 'owner', CHAT_PAYMENT_ACCEPTANCE_AGENT_IDS: 'agent', CHAT_PAYMENT_ACCEPTANCE_PAYER_ADDRESSES: 'payer', CHAT_PAYMENT_ACCEPTANCE_PLATFORM_RECIPIENTS: 'platform', CHAT_PAYMENT_ACCEPTANCE_AGENT_RECIPIENTS: 'recipient' }
  assert.doesNotThrow(() => assertChatPaymentAcceptanceAllowed(intent, env))
  assert.doesNotThrow(() => assertChatPaymentAcceptanceAllowed({ ...intent, userId: 'ordinary', agentId: 'new-agent', payer: 'new-payer', agentRecipient: 'new-recipient', platformRecipient: 'new-platform' }, env))
  assert.doesNotThrow(() => assertChatPaymentAcceptanceAllowed(intent, { NODE_ENV: 'test', ENABLE_CHAT_PAYMENT_ACCEPTANCE: 'true' }))
  assert.throws(() => assertChatPaymentAcceptanceAllowed(intent, { ...env, ENABLE_CHAT_PAYMENT_ACCEPTANCE: 'false' }), /acceptance_disabled/)
})
