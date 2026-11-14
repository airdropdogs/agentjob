import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { NextRequest } from 'next/server'
import { acceptanceChat } from './acceptance-chat-route'
import { createChatPaymentAcceptance, ChatPaymentAcceptanceError } from './chat-payment-acceptance'

test('settled chat acceptance delivers exactly one task/payment/message on concurrent phase replay', { skip: !process.env.TEST_ACCEPTANCE_DATABASE_URL, timeout: 120000 }, async () => {
  const url = new URL(process.env.TEST_ACCEPTANCE_DATABASE_URL!)
  assert.equal(url.pathname, '/agentjob_tests', 'Only the isolated agentjob_tests database is permitted')
  const schema = `acceptance_route_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url.toString(), max: 1 })
  const pool = new Pool({ connectionString: url.toString(), max: 5, options: `-c search_path=${schema}` })
  const globalDb = globalThis as typeof globalThis & { agentjobPool?: Pool }
  const previousPool = globalDb.agentjobPool
  const previousFetch = globalThis.fetch
  const userId = randomUUID(), agentId = randomUUID(), chatId = randomUUID(), key = randomUUID()
  const payer = `0x${'1'.repeat(40)}`, platformRecipient = `0x${'2'.repeat(40)}`, agentRecipient = `0x${'3'.repeat(40)}`
  const txPlatform = `0x${'a'.repeat(64)}`, txAgent = `0x${'b'.repeat(64)}`
  const attachments = [{ id: randomUUID(), name: 'report.txt', contentType: 'text/plain', size: 12 }]
  const messages = [{ role: 'user', content: 'Reply to this isolated acceptance test', attachments }]
  const env = {
    NODE_ENV: 'test' as const, ENABLE_CHAT_PAYMENT_ACCEPTANCE: 'true',
    CHAT_PAYMENT_ACCEPTANCE_USER_IDS: userId, CHAT_PAYMENT_ACCEPTANCE_AGENT_IDS: agentId,
    CHAT_PAYMENT_ACCEPTANCE_PAYER_ADDRESSES: payer, CHAT_PAYMENT_ACCEPTANCE_PLATFORM_RECIPIENTS: platformRecipient,
    CHAT_PAYMENT_ACCEPTANCE_AGENT_RECIPIENTS: agentRecipient,
  }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0004_chat_payment_acceptance.sql'), 'utf8'))
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0012_zero_platform_fee.sql'), 'utf8'))
    // LIKE copies columns/defaults/indexes, but not foreign keys into public business tables.
    for (const table of ['users', 'agent_profiles', 'chats', 'payments', 'messages', 'agent_chat_tasks']) {
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`)
    }
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0006_chat_attachments.sql'), 'utf8'))
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0007_chat_deliveries.sql'), 'utf8'))
    globalDb.agentjobPool = pool
    const ledger = createChatPaymentAcceptance({ pool, env, policy: async () => ({ chatPaymentsEnabled: true, chatMaxMessageUsdc: 100, chatMaxAuthorizationUsdc: 100, chatAuthorizationMinutes: 60 }) })
    const prepared = await ledger.prepare({ userId, agentId, chatId, idempotencyKey: key, messages, payer, platformRecipient, agentRecipient, totalMicro: 100000, platformFeeMicro: 5000 })
    let mockSettlements = 0
    await ledger.executeStage({ userId, idempotencyKey: key, stage: 'platform_fee', verify: async () => true, settle: async () => { mockSettlements++; return { transaction: txPlatform } } })
    await ledger.executeStage({ userId, idempotencyKey: key, stage: 'agent', verify: async () => true, settle: async () => { mockSettlements++; return { transaction: txAgent } } })
    // Delivery/replays must use persisted receipts even when real payment credentials are absent.
    globalThis.fetch = async () => { assert.fail('Settled replay must never call a facilitator') }
    const request = {
      req: new NextRequest('https://agent-job.ai/api/chat', { method: 'POST' }),
      session: { userId, email: 'acceptance-test@example.invalid', role: 'user' as const, wallet: payer, cdpVerified: true },
      agentId, chatId, key, messages, totalUsdc: '0.100000', feeRate: 0.05, agentWallet: agentRecipient, online: true,
    }
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => acceptanceChat({ ...request, stage: index % 2 ? 'agent' : 'platform_fee' })))
    assert.ok(responses.every(response => response.status === 202))
    const bodies = await Promise.all(responses.map(response => response.json()))
    const taskId = bodies[0].task_id
    assert.ok(taskId)
    assert.ok(bodies.every(body => body.task_id === taskId && body.chat_id === chatId))
    assert.equal(mockSettlements, 2)
    for (const table of ['chats', 'payments', 'messages', 'agent_chat_tasks']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1, `${table} must be inserted once`)
    }
    const payment = (await pool.query('SELECT * FROM payments')).rows[0]
    assert.equal(payment.tx_platform, txPlatform)
    assert.equal(payment.tx_agent, txAgent)
    assert.equal(payment.amount_platform, '0.005000')
    assert.equal(payment.amount_agent, '0.095000')
    assert.equal(payment.x402_payment_id, prepared.id)
    const chat = (await pool.query('SELECT * FROM chats')).rows[0]
    assert.equal(chat.total_messages, 1)
    assert.equal(chat.total_spent, '0.100000')
    const task = (await pool.query('SELECT * FROM agent_chat_tasks')).rows[0]
    assert.equal(task.id, taskId)
    assert.deepEqual(task.messages, messages)
    assert.deepEqual((await pool.query('SELECT attachments FROM messages')).rows[0].attachments, attachments)
    assert.equal((await ledger.get({ userId, idempotencyKey: key }))?.taskId, taskId)
    await assert.rejects(acceptanceChat({ ...request, stage: 'agent', messages: [{ role: 'user', content: 'Different message' }] }), error => error instanceof ChatPaymentAcceptanceError && error.status === 409 && error.code === 'acceptance_idempotency_conflict')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_chat_tasks')).rows[0].n, 1)
    const zeroKey = randomUUID(), zeroChat = randomUUID()
    await ledger.prepare({ userId, agentId, chatId: zeroChat, idempotencyKey: zeroKey, messages, payer, platformRecipient, agentRecipient, totalMicro: 100000, platformFeeMicro: 0 })
    assert.equal((await acceptanceChat({ ...request, chatId: zeroChat, key: zeroKey, feeRate: 0, stage: 'platform_fee' })).status, 200)
    await ledger.executeStage({ userId, idempotencyKey: zeroKey, stage: 'agent', verify: async () => true, settle: async () => ({ transaction: '0x' + 'c'.repeat(64) }) })
    const zeroResponse = await acceptanceChat({ ...request, chatId: zeroChat, key: zeroKey, feeRate: 0, stage: 'agent' })
    assert.equal(zeroResponse.status, 202)
    assert.equal((await acceptanceChat({ ...request, chatId: zeroChat, key: zeroKey, feeRate: 0, stage: 'agent' })).status, 202)
    const zeroPayment = (await pool.query('SELECT * FROM payments WHERE chat_id=$1', [zeroChat])).rows
    assert.equal(zeroPayment.length, 1)
    assert.equal(zeroPayment[0].tx_platform, null)
    assert.equal(zeroPayment[0].amount_platform, '0.000000')
    assert.equal(zeroPayment[0].amount_agent, '0.100000')
  } finally {
    globalThis.fetch = previousFetch
    if (previousPool) globalDb.agentjobPool = previousPool
    else delete globalDb.agentjobPool
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
})
