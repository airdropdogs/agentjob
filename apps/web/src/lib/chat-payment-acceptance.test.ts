import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { createChatPaymentAcceptance, ChatPaymentAcceptanceError } from './chat-payment-acceptance'

import { DEFAULT_CHAT_PAYMENT_POLICY } from './chat-payment-policy'
const policy = async () => ({ ...DEFAULT_CHAT_PAYMENT_POLICY, chatMaxMessageUsdc: 0.1 })

const userId = randomUUID(), agentId = randomUUID(), chatId = randomUUID()
const payer = `0x${'1'.repeat(40)}`, platformRecipient = `0x${'2'.repeat(40)}`, agentRecipient = `0x${'3'.repeat(40)}`
const tx = (digit: string) => `0x${digit.repeat(64)}`
const config = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ENABLE_CHAT_PAYMENT_ACCEPTANCE: 'true',
  CHAT_PAYMENT_ACCEPTANCE_USER_IDS: userId, CHAT_PAYMENT_ACCEPTANCE_AGENT_IDS: agentId,
  CHAT_PAYMENT_ACCEPTANCE_PAYER_ADDRESSES: payer, CHAT_PAYMENT_ACCEPTANCE_PLATFORM_RECIPIENTS: platformRecipient,
  CHAT_PAYMENT_ACCEPTANCE_AGENT_RECIPIENTS: agentRecipient,
})
const input = (key = randomUUID()) => ({ userId, agentId, chatId, idempotencyKey: key, messages: [{ role: 'user', content: 'test' }], payer, platformRecipient, agentRecipient, totalMicro: 100000, platformFeeMicro: 5000 })
const errorCode = (code: string) => (error: unknown) => error instanceof ChatPaymentAcceptanceError && error.code === code

test('acceptance uses durable PostgreSQL reservations and settlement claims; no real facilitator calls', { skip: !process.env.TEST_ACCEPTANCE_DATABASE_URL, timeout: 240000 }, async t => {
  const url = new URL(process.env.TEST_ACCEPTANCE_DATABASE_URL!)
  assert.equal(url.pathname, '/agentjob_tests', 'Only the isolated agentjob_tests database is permitted')
  const schema = `acceptance_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url.toString(), max: 1 })
  const pool = new Pool({ connectionString: url.toString(), max: 12, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0004_chat_payment_acceptance.sql'), 'utf8'))
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0012_zero_platform_fee.sql'), 'utf8'))
    await pool.query('CREATE TABLE platform_config (key text PRIMARY KEY, value text NOT NULL)')
    await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/0013_formal_chat_payments.sql'), 'utf8'))
    const reset = () => pool.query('TRUNCATE chat_payment_acceptance_receipts,chat_payment_acceptance_intents,chat_payment_acceptance_budgets')
    await t.test('zero fee skips platform settlement and pays the provider once', async () => {
      const api = createChatPaymentAcceptance({ pool, policy, env: config() }), request = { ...input(), platformFeeMicro: 0 }
      const intent = await api.prepare(request)
      assert.equal(intent.platformStatus, 'settled')
      assert.equal(intent.agentMicro, request.totalMicro)
      assert.equal((await api.prepare({ ...request, platformFeeMicro: 5000 })).platformFeeMicro, 0)
      let calls = 0
      const settle = async () => { calls++; return { transaction: tx('f') } }
      await api.executeStage({ ...request, stage: 'platform_fee', verify: async () => { throw Error('Must not verify zero fee') }, settle })
      assert.equal(calls, 0)
      await api.executeStage({ ...request, stage: 'agent', verify: async () => true, settle })
      await api.executeStage({ ...request, stage: 'agent', verify: async () => true, settle })
      assert.equal(calls, 1)
      const final = await api.finalize(request, async () => ({ taskId: randomUUID() }))
      assert.equal(final.receipts.length, 1)
      assert.equal(final.receipts[0].amountMicro, request.totalMicro)
      await assert.rejects(api.prepare({ ...input(), platformFeeMicro: -1 }), errorCode('invalid_amount'))
      await reset()
    })
    await t.test('concurrent intents preserve accounting beyond the former lifetime ceiling', async () => {
      const api = createChatPaymentAcceptance({ pool, policy, env: config() })
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => api.prepare(input())))
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 12)
      assert.equal((await pool.query('SELECT reserved_micro FROM chat_payment_acceptance_budgets')).rows[0].reserved_micro, '1200000')
      await assert.rejects(pool.query('UPDATE chat_payment_acceptance_budgets SET reserved_micro=-1'))
      await reset()
    })
    await t.test('same key reserves once, freezes quote and rejects changed message or identity', async () => {
      const env = config(), api = createChatPaymentAcceptance({ pool, policy, env }), request = input()
      const intents = await Promise.all(Array.from({ length: 5 }, () => api.prepare(request)))
      assert.equal(new Set(intents.map(intent => intent.id)).size, 1)
      assert.equal((await pool.query('SELECT reserved_micro FROM chat_payment_acceptance_budgets')).rows[0].reserved_micro, '100000')
      assert.equal((await api.prepare({ ...request, totalMicro: 200000 })).totalMicro, 100000)
      await assert.rejects(api.prepare({ ...request, messages: ['changed'] }), errorCode('acceptance_idempotency_conflict'))
      await assert.rejects(api.prepare({ ...request, chatId: randomUUID() }), errorCode('acceptance_idempotency_conflict'))
      env.ENABLE_CHAT_PAYMENT_ACCEPTANCE = 'false'
      assert.equal((await api.prepare(request)).id, intents[0].id)
      await assert.rejects(api.prepare(input()), errorCode('acceptance_disabled'))
      await reset()
    })
    await t.test('missing whitelist is allowed while invalid or oversized limits fail closed', async () => {
      const env = config(); delete env.CHAT_PAYMENT_ACCEPTANCE_PAYER_ADDRESSES
      await createChatPaymentAcceptance({ pool, policy, env }).prepare(input())
      await assert.rejects(createChatPaymentAcceptance({ pool, policy: async () => ({ ...DEFAULT_CHAT_PAYMENT_POLICY, chatMaxMessageUsdc: NaN }), env: config() }).prepare(input()), errorCode('acceptance_invalid_limit'))
      await assert.rejects(createChatPaymentAcceptance({ pool, policy, env: config() }).prepare({ ...input(), totalMicro: 100001 }), errorCode('acceptance_intent_limit'))
      await reset()
    })
    await t.test('verify can retry, simultaneous settle is claimed once, receipts replay while disabled', async () => {
      const env = config(), api = createChatPaymentAcceptance({ pool, policy, env }), request = input()
      await api.prepare(request)
      let settleCalls = 0
      const stage = { ...request, stage: 'platform_fee' as const, verify: async () => true, settle: async () => { settleCalls++; return { transaction: tx('a') } } }
      await assert.rejects(api.executeStage({ ...stage, stage: 'agent' }), errorCode('acceptance_platform_fee_required'))
      assert.equal((await api.executeStage({ ...stage, verify: async () => false })).status, 'verify_failed')
      const results = await Promise.all(Array.from({ length: 5 }, () => api.executeStage(stage)))
      assert.equal(settleCalls, 1)
      assert.ok(results.some(result => result.status === 'settled'))
      env.ENABLE_CHAT_PAYMENT_ACCEPTANCE = 'false'
      assert.equal((await api.executeStage(stage)).receipt?.transaction, tx('a'))
      await assert.rejects(api.executeStage({ ...stage, stage: 'agent' }), errorCode('acceptance_disabled'))
      assert.equal(settleCalls, 1)
      await reset()
    })
    await t.test('disable during verification prevents settlement; uncertain settlement never retries', async () => {
      const env = config(), api = createChatPaymentAcceptance({ pool, policy, env }), request = input()
      await api.prepare(request)
      let settleCalls = 0
      const stage = { ...request, stage: 'platform_fee' as const, verify: async () => true, settle: async () => { settleCalls++; throw new Error('lost facilitator response') } }
      await assert.rejects(api.executeStage({ ...stage, verify: async () => { env.ENABLE_CHAT_PAYMENT_ACCEPTANCE = 'false'; return true } }), errorCode('acceptance_disabled'))
      assert.equal(settleCalls, 0)
      env.ENABLE_CHAT_PAYMENT_ACCEPTANCE = 'true'
      assert.equal((await api.executeStage(stage)).status, 'uncertain')
      assert.equal((await api.executeStage(stage)).status, 'uncertain')
      assert.equal(settleCalls, 1)
      assert.equal((await pool.query('SELECT reserved_micro FROM chat_payment_acceptance_budgets')).rows[0].reserved_micro, '100000')
      await reset()
    })
    await t.test('one chain receipt cannot credit two intents and interrupted claims never auto-retry', async () => {
      const api = createChatPaymentAcceptance({ pool, policy, env: config() }), first = input(), second = input()
      await api.prepare(first); await api.prepare(second)
      const callbacks = { stage: 'platform_fee' as const, verify: async () => true, settle: async () => ({ transaction: tx('b') }) }
      assert.equal((await api.executeStage({ ...first, ...callbacks })).status, 'settled')
      assert.equal((await api.executeStage({ ...second, ...callbacks })).status, 'uncertain')
      await pool.query("UPDATE chat_payment_acceptance_intents SET agent_status='settling' WHERE idempotency_key=$1", [first.idempotencyKey])
      assert.equal((await api.executeStage({ ...first, ...callbacks, stage: 'agent', settle: async () => { assert.fail('must not settle again') } })).status, 'busy')
      await reset()
    })
    await t.test('delivery and task ID commit once; rollback allows safe delivery retry', async () => {
      const api = createChatPaymentAcceptance({ pool, policy, env: config() }), request = input()
      await api.prepare(request)
      await api.executeStage({ ...request, stage: 'platform_fee', verify: async () => true, settle: async () => ({ transaction: tx('c') }) })
      await api.executeStage({ ...request, stage: 'agent', verify: async () => true, settle: async () => ({ transaction: tx('d') }) })
      await pool.query('CREATE TABLE delivery_test(task_id uuid PRIMARY KEY)')
      const taskId = randomUUID()
      await assert.rejects(api.finalize(request, async client => { await client.query('INSERT INTO delivery_test VALUES($1)', [taskId]); throw new Error('rollback delivery') }), /rollback delivery/)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM delivery_test')).rows[0].n, 0)
      let deliveries = 0
      const results = await Promise.all(Array.from({ length: 4 }, () => api.finalize(request, async client => { deliveries++; await client.query('INSERT INTO delivery_test VALUES($1)', [taskId]); return { taskId } })))
      assert.equal(deliveries, 1)
      assert.ok(results.every(result => result.taskId === taskId))
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM delivery_test')).rows[0].n, 1)
    })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
})
