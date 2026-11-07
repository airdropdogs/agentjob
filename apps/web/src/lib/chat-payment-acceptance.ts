import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { getPool } from './db'

export const CHAT_PAYMENT_ACCEPTANCE_CAMPAIGN = 'base-usdc-acceptance-v1'
export const CHAT_PAYMENT_ACCEPTANCE_CAP_MICRO = 1_000_000
export const CHAT_PAYMENT_ACCEPTANCE_ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export type AcceptanceStage = 'platform_fee' | 'agent'
export type AcceptanceStageStatus = 'pending' | 'processing' | 'settling' | 'settled' | 'uncertain'
export type AcceptanceReceipt = { transaction: string; stage: AcceptanceStage; amountMicro: number; recipient: string; payer: string }
export type AcceptanceIntent = {
  id: string; userId: string; agentId: string; chatId: string; idempotencyKey: string; messagesHash: string
  payer: string; platformRecipient: string; agentRecipient: string; totalMicro: number; platformFeeMicro: number; agentMicro: number
  platformStatus: AcceptanceStageStatus; agentStatus: AcceptanceStageStatus
  taskId: string | null; receipts: AcceptanceReceipt[]; delivery: Record<string, unknown> | null
}
export type PrepareAcceptanceInput = {
  userId: string; agentId: string; chatId: string; idempotencyKey: string; messages: unknown
  payer: string; platformRecipient: string; agentRecipient: string; totalMicro: number; platformFeeMicro: number
}
export class ChatPaymentAcceptanceError extends Error {
  constructor(public code: string, public status: number) { super(code) }
}
const fail = (code: string, status = 409): never => { throw new ChatPaymentAcceptanceError(code, status) }
const campaign = CHAT_PAYMENT_ACCEPTANCE_CAMPAIGN
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value)
    if (result === undefined) return fail('invalid_messages', 400)
    return result
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}
export const acceptanceMessagesHash = (messages: unknown) => createHash('sha256').update(canonicalJson(messages)).digest('hex')
const address = (value: string) => /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : fail('invalid_address', 400)
const column = (stage: AcceptanceStage) => stage === 'platform_fee' ? 'platform_status' : stage === 'agent' ? 'agent_status' : fail('invalid_stage', 400)

type Row = {
  id: string; user_id: string; agent_id: string; chat_id: string; idempotency_key: string; messages_hash: string
  payer: string; platform_recipient: string; agent_recipient: string; total_micro: number; platform_fee_micro: number
  platform_status: AcceptanceStageStatus; agent_status: AcceptanceStageStatus; task_id: string | null; delivery: Record<string, unknown> | null
}
async function read(client: PoolClient, userId: string, key: string, lock = false): Promise<AcceptanceIntent | null> {
  const result = await client.query<Row>(`SELECT * FROM chat_payment_acceptance_intents WHERE campaign_id=$1 AND user_id=$2 AND idempotency_key=$3${lock ? ' FOR UPDATE' : ''}`, [campaign, userId, key])
  const r = result.rows[0]
  if (!r) return null
  const receipts = await client.query<{ transaction: string; stage: AcceptanceStage; amount_micro: number; recipient: string; payer: string }>('SELECT * FROM chat_payment_acceptance_receipts WHERE intent_id=$1', [r.id])
  return { id: r.id, userId: r.user_id, agentId: r.agent_id, chatId: r.chat_id, idempotencyKey: r.idempotency_key, messagesHash: r.messages_hash,
    payer: r.payer, platformRecipient: r.platform_recipient, agentRecipient: r.agent_recipient, totalMicro: r.total_micro,
    platformFeeMicro: r.platform_fee_micro, agentMicro: r.total_micro - r.platform_fee_micro,
    platformStatus: r.platform_status, agentStatus: r.agent_status, taskId: r.task_id, delivery: r.delivery,
    receipts: receipts.rows.map(receipt => ({ transaction: receipt.transaction, stage: receipt.stage, amountMicro: receipt.amount_micro, recipient: receipt.recipient, payer: receipt.payer })) }
}

export function assertChatPaymentAcceptanceAllowed(intent: Pick<AcceptanceIntent, 'userId' | 'agentId' | 'payer' | 'platformRecipient' | 'agentRecipient' | 'totalMicro'>, config: NodeJS.ProcessEnv = process.env) {
    if (config.ENABLE_CHAT_PAYMENT_ACCEPTANCE !== 'true') fail('acceptance_disabled', 503)
    const allowed = (key: string, value: string) => (config[key] ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean).includes(value.toLowerCase())
    const matches = [
      ['CHAT_PAYMENT_ACCEPTANCE_USER_IDS', intent.userId], ['CHAT_PAYMENT_ACCEPTANCE_AGENT_IDS', intent.agentId],
      ['CHAT_PAYMENT_ACCEPTANCE_PAYER_ADDRESSES', intent.payer], ['CHAT_PAYMENT_ACCEPTANCE_PLATFORM_RECIPIENTS', intent.platformRecipient],
      ['CHAT_PAYMENT_ACCEPTANCE_AGENT_RECIPIENTS', intent.agentRecipient],
    ]
    if (!matches.every(([key, value]) => allowed(key, value))) fail('acceptance_not_allowed', 403)
    const maximum = Number(config.CHAT_PAYMENT_ACCEPTANCE_MAX_INTENT_MICRO ?? 100_000)
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > CHAT_PAYMENT_ACCEPTANCE_CAP_MICRO) fail('acceptance_invalid_limit', 503)
    if (intent.totalMicro > maximum) fail('acceptance_intent_limit', 403)
  }

export function createChatPaymentAcceptance(options: { pool?: Pool; env?: NodeJS.ProcessEnv } = {}) {
  const pool = () => options.pool ?? getPool()
  const env = () => options.env ?? process.env
  const assertAllowed = (intent: Pick<AcceptanceIntent, 'userId' | 'agentId' | 'payer' | 'platformRecipient' | 'agentRecipient' | 'totalMicro'>) => assertChatPaymentAcceptanceAllowed(intent, env())
  async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool().connect()
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  async function get(input: { userId: string; idempotencyKey: string }) {
    const client = await pool().connect()
    try { return await read(client, input.userId, input.idempotencyKey) } finally { client.release() }
  }
  async function prepare(input: PrepareAcceptanceInput): Promise<AcceptanceIntent> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) fail('invalid_idempotency_key', 400)
    if (![input.userId, input.agentId, input.chatId].every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) fail('invalid_identity', 400)
    const normalized = { ...input, payer: address(input.payer), platformRecipient: address(input.platformRecipient), agentRecipient: address(input.agentRecipient) }
    const hash = acceptanceMessagesHash(input.messages)
    const checkExisting = (existing: AcceptanceIntent) => {
      if (existing.agentId !== input.agentId || existing.chatId !== input.chatId || existing.messagesHash !== hash || existing.payer !== normalized.payer || existing.platformRecipient !== normalized.platformRecipient || existing.agentRecipient !== normalized.agentRecipient) fail('acceptance_idempotency_conflict')
      return existing // The first quote is immutable even if current pricing changes.
    }
    const existing = await get(input)
    if (existing) return checkExisting(existing)
    assertAllowed(normalized)
    if (!Number.isSafeInteger(input.totalMicro) || !Number.isSafeInteger(input.platformFeeMicro) || input.totalMicro <= 0 || input.totalMicro > CHAT_PAYMENT_ACCEPTANCE_CAP_MICRO || input.platformFeeMicro < 0 || input.platformFeeMicro >= input.totalMicro) fail('invalid_amount', 400)
    return transaction(async client => {
      await client.query('INSERT INTO chat_payment_acceptance_budgets(campaign_id) VALUES($1) ON CONFLICT DO NOTHING', [campaign])
      await client.query('SELECT campaign_id FROM chat_payment_acceptance_budgets WHERE campaign_id=$1 FOR UPDATE', [campaign])
      const raced = await read(client, input.userId, input.idempotencyKey)
      if (raced) return checkExisting(raced)
      assertAllowed(normalized)
      const reserved = await client.query('UPDATE chat_payment_acceptance_budgets SET reserved_micro=reserved_micro+$2 WHERE campaign_id=$1 AND reserved_micro+$2 <= $3 RETURNING reserved_micro', [campaign, input.totalMicro, CHAT_PAYMENT_ACCEPTANCE_CAP_MICRO])
      if (!reserved.rowCount) fail('acceptance_budget_exhausted', 403)
      await client.query(`INSERT INTO chat_payment_acceptance_intents(id,campaign_id,user_id,agent_id,chat_id,idempotency_key,messages_hash,payer,platform_recipient,agent_recipient,total_micro,platform_fee_micro) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [randomUUID(), campaign, input.userId, input.agentId, input.chatId, input.idempotencyKey, hash, normalized.payer, normalized.platformRecipient, normalized.agentRecipient, input.totalMicro, input.platformFeeMicro])
      if (input.platformFeeMicro === 0) await client.query("UPDATE chat_payment_acceptance_intents SET platform_status='settled' WHERE campaign_id=$1 AND user_id=$2 AND idempotency_key=$3", [campaign, input.userId, input.idempotencyKey])
      return (await read(client, input.userId, input.idempotencyKey))!
    })
  }
  async function executeStage(input: {
    userId: string; idempotencyKey: string; stage: AcceptanceStage
    verify: (intent: AcceptanceIntent) => Promise<boolean>
    settle: (intent: AcceptanceIntent) => Promise<{ transaction: string }>
  }): Promise<{ status: 'settled' | 'verify_failed' | 'busy' | 'uncertain'; intent: AcceptanceIntent; receipt?: AcceptanceReceipt }> {
    const field = column(input.stage)
    const claimed = await transaction(async client => {
      const intent = await read(client, input.userId, input.idempotencyKey, true)
      if (!intent) return fail('acceptance_not_found', 404)
      const status = input.stage === 'platform_fee' ? intent.platformStatus : intent.agentStatus
      if (status === 'settled') return { intent, status: 'settled' as const }
      if (status === 'uncertain') return { intent, status: 'uncertain' as const }
      if (status === 'processing' || status === 'settling') return { intent, status: 'busy' as const }
      assertAllowed(intent)
      if (input.stage === 'agent' && intent.platformStatus !== 'settled') return fail('acceptance_platform_fee_required')
      await client.query(`UPDATE chat_payment_acceptance_intents SET ${field}='processing' WHERE id=$1`, [intent.id])
      return { intent, status: 'claimed' as const }
    })
    const { intent } = claimed
    if (claimed.status !== 'claimed') return { status: claimed.status, intent, receipt: intent.receipts.find(receipt => receipt.stage === input.stage) }
    let verified = false
    try { verified = await input.verify(intent) } catch { /* Verification alone never moves funds; retry is safe. */ }
    if (!verified) {
      await pool().query(`UPDATE chat_payment_acceptance_intents SET ${field}='pending' WHERE id=$1 AND ${field}='processing'`, [intent.id])
      return { status: 'verify_failed', intent: (await get(input))! }
    }
    try { assertAllowed(intent) } catch (error) {
      await pool().query(`UPDATE chat_payment_acceptance_intents SET ${field}='pending' WHERE id=$1 AND ${field}='processing'`, [intent.id])
      throw error
    }
    await pool().query(`UPDATE chat_payment_acceptance_intents SET ${field}='settling' WHERE id=$1 AND ${field}='processing'`, [intent.id])
    try {
      assertAllowed(intent)
    } catch (error) {
      await pool().query(`UPDATE chat_payment_acceptance_intents SET ${field}='pending' WHERE id=$1 AND ${field}='settling'`, [intent.id])
      throw error
    }
    try {
      const result = await input.settle(intent)
      if (!/^0x[0-9a-f]{64}$/i.test(result.transaction)) throw new Error('Invalid settlement receipt')
      const receipt: AcceptanceReceipt = { transaction: result.transaction.toLowerCase(), stage: input.stage,
        amountMicro: input.stage === 'platform_fee' ? intent.platformFeeMicro : intent.agentMicro,
        recipient: input.stage === 'platform_fee' ? intent.platformRecipient : intent.agentRecipient, payer: intent.payer }
      await transaction(async client => {
        await client.query('INSERT INTO chat_payment_acceptance_receipts(transaction,intent_id,stage,amount_micro,recipient,payer) VALUES($1,$2,$3,$4,$5,$6)', [receipt.transaction, intent.id, input.stage, receipt.amountMicro, receipt.recipient, receipt.payer])
        await client.query(`UPDATE chat_payment_acceptance_intents SET ${field}='settled' WHERE id=$1 AND ${field}='settling'`, [intent.id])
      })
      return { status: 'settled', intent: (await get(input))!, receipt }
    } catch {
      // Includes an ambiguous facilitator response, lost connection, or failure to persist a receipt.
      // Never release the budget and never retry settlement automatically.
      await pool().query(`UPDATE chat_payment_acceptance_intents SET ${field}='uncertain' WHERE id=$1 AND ${field}='settling'`, [intent.id]).catch(() => {})
      return { status: 'uncertain', intent: (await get(input))! }
    }
  }
  async function finalize<T extends { taskId: string } & Record<string, unknown>>(input: { userId: string; idempotencyKey: string }, deliver: (client: PoolClient, intent: AcceptanceIntent) => Promise<T>): Promise<AcceptanceIntent> {
    return transaction(async client => {
      const intent = await read(client, input.userId, input.idempotencyKey, true)
      if (!intent) return fail('acceptance_not_found', 404)
      if (intent.taskId !== null) return intent
      if (intent.platformStatus !== 'settled' || intent.agentStatus !== 'settled') return fail('acceptance_payment_incomplete')
      const delivery = await deliver(client, intent)
      await client.query('UPDATE chat_payment_acceptance_intents SET delivery=$2::jsonb, task_id=$3 WHERE id=$1', [intent.id, JSON.stringify(delivery), delivery.taskId])
      return (await read(client, input.userId, input.idempotencyKey))!
    })
  }
  return { prepare, get, executeStage, finalize }
}
