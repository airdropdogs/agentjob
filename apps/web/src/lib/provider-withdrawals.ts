import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export class WithdrawalError extends Error {
  constructor(public code: string, public status = 400) { super(code) }
}
export function parseWithdrawal(to: unknown, amount: unknown, key: unknown) {
  if (typeof to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(to) || /^0x0{40}$/i.test(to) || to.toLowerCase() === USDC.toLowerCase()) throw new WithdrawalError('INVALID_RECIPIENT')
  if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,17})(\.\d{1,6})?$/.test(amount)) throw new WithdrawalError('INVALID_USDC_AMOUNT')
  const [whole, fraction = ''] = amount.split('.')
  const units = BigInt(whole) * BigInt(1000000) + BigInt(fraction.padEnd(6, '0'))
  if (units <= BigInt(0)) throw new WithdrawalError('INVALID_USDC_AMOUNT')
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new WithdrawalError('INVALID_IDEMPOTENCY_KEY')
  return { to: to.toLowerCase(), units, key }
}
export type WithdrawalRow = {
  id: string; user_id: string; agent_id: string; idempotency_key: string;
  source_address: string; to_address: string; amount_units: string;
  status: string; transaction_hash: string | null; error_code: string | null; created_at: Date;
}
export function withdrawalView(row: WithdrawalRow) {
  const units = BigInt(row.amount_units)
  return { id: row.id, network: 'base', token: 'USDC', sourceAddress: row.source_address,
    toAddress: row.to_address, amount: `${units / BigInt(1000000)}.${(units % BigInt(1000000)).toString().padStart(6, '0')}`,
    status: row.status, transactionHash: row.transaction_hash, errorCode: row.error_code,
    explorerUrl: row.transaction_hash ? `https://basescan.org/tx/${row.transaction_hash}` : null }
}
export type Receipt = { status: string; blockNumber: string; logs: { address: string; topics: string[]; data: string }[] }
export function receiptMatches(row: WithdrawalRow, receipt: Receipt) {
  return receipt.logs.some(log => log.address.toLowerCase() === USDC.toLowerCase()
    && log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3
    && log.topics[1].slice(-40).toLowerCase() === row.source_address.slice(2).toLowerCase()
    && log.topics[2].slice(-40).toLowerCase() === row.to_address.slice(2).toLowerCase()
    && /^0x[0-9a-f]+$/i.test(log.data) && BigInt(log.data) === BigInt(row.amount_units))
}
export type WithdrawalDeps = {
  pool: Pool;
  enabled: () => boolean | Promise<boolean>;
  config: () => Promise<{ walletTransferMinUsdc: number; walletTransferCooldownDays: number }>;
  preflight: (source: string, to: string, units: bigint) => Promise<void>;
  send: (source: string, to: string, units: bigint, id: string) => Promise<string>;
  receipt: (hash: string) => Promise<{ receipt: Receipt | null; block: bigint }>;
}

export async function createWithdrawal(agentId: string, input: ReturnType<typeof parseWithdrawal>, deps: WithdrawalDeps) {
  const db = await deps.pool.connect()
  let row: WithdrawalRow
  try {
    await db.query('BEGIN')
    // Serialize reservation and policy checks per owner across all API workers.
    const owner = (await db.query(`SELECT u.* FROM users u JOIN agent_profiles a ON a.user_id=u.id WHERE a.id=$1 FOR UPDATE OF u`, [agentId])).rows[0]
    if (!owner || owner.banned_at) throw new WithdrawalError('UNAUTHORIZED', 401)
    if (owner.wallet_type !== 'server_wallet' || !owner.wallet || !owner.cdp_account_name) throw new WithdrawalError('SERVER_WALLET_REQUIRED', 403)
    const existing = (await db.query('SELECT * FROM provider_withdrawals WHERE user_id=$1 AND idempotency_key=$2', [owner.id, input.key])).rows[0] as WithdrawalRow | undefined
    if (existing) {
      if (existing.to_address !== input.to || BigInt(existing.amount_units) !== input.units) throw new WithdrawalError('IDEMPOTENCY_CONFLICT', 409)
      await db.query('COMMIT')
      return existing
    }
    if (!(await deps.enabled())) throw new WithdrawalError('TRANSFERS_DISABLED', 503)
    if (owner.wallet.toLowerCase() === input.to) throw new WithdrawalError('SELF_TRANSFER_NOT_ALLOWED')
    const active = await db.query("SELECT id FROM provider_withdrawals WHERE user_id=$1 AND status IN ('submitting','submitted','review_required') LIMIT 1", [owner.id])
    if (active.rows.length) throw new WithdrawalError('WITHDRAWAL_IN_PROGRESS', 409)
    const config = await deps.config()
    if (!Number.isFinite(config.walletTransferMinUsdc) || config.walletTransferMinUsdc < 0 || !Number.isFinite(config.walletTransferCooldownDays) || config.walletTransferCooldownDays < 0) throw new WithdrawalError('INVALID_WITHDRAWAL_POLICY', 503)
    if (input.units < BigInt(Math.ceil(config.walletTransferMinUsdc * 1000000))) throw new WithdrawalError('BELOW_MINIMUM_TRANSFER')
    const last = (await db.query('SELECT last_usdc_transfer_at FROM user_wallet_settings WHERE user_id=$1', [owner.id])).rows[0]?.last_usdc_transfer_at
    if (last && new Date(last).getTime() + config.walletTransferCooldownDays * 86400000 > Date.now()) throw new WithdrawalError('TRANSFER_COOLDOWN', 429)
    await deps.preflight(owner.wallet, input.to, input.units)
    row = (await db.query(`INSERT INTO provider_withdrawals
      (id,user_id,agent_id,idempotency_key,source_address,to_address,amount_units,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'submitting') RETURNING *`,
    [randomUUID(), owner.id, agentId, input.key, owner.wallet, input.to, input.units.toString()])).rows[0]
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally { db.release() }

  // Durable reservation is committed before any external signing/broadcast.
  // Never automatically resend a submission whose result is uncertain.
  let hash: string | null = null
  try {
    hash = await deps.send(row.source_address, row.to_address, BigInt(row.amount_units), row.id)
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Invalid transaction hash')
    row = (await deps.pool.query("UPDATE provider_withdrawals SET status='submitted',transaction_hash=$2,updated_at=now() WHERE id=$1 RETURNING *", [row.id, hash])).rows[0]
  } catch {
    row = (await deps.pool.query("UPDATE provider_withdrawals SET status='review_required',transaction_hash=COALESCE($2,transaction_hash),error_code='SUBMISSION_UNCERTAIN',updated_at=now() WHERE id=$1 RETURNING *", [row.id, hash])).rows[0]
  }
  return row
}

export async function getWithdrawal(agentId: string, id: string, deps: WithdrawalDeps) {
  const row = (await deps.pool.query(`SELECT w.* FROM provider_withdrawals w
    JOIN agent_profiles a ON a.user_id=w.user_id JOIN users u ON u.id=w.user_id
    WHERE a.id=$1 AND w.id=$2 AND u.banned_at IS NULL`, [agentId, id])).rows[0] as WithdrawalRow | undefined
  if (!row) throw new WithdrawalError('WITHDRAWAL_NOT_FOUND', 404)
  if (row.status === 'submitting' && Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) {
    return (await deps.pool.query("UPDATE provider_withdrawals SET status='review_required',error_code='SUBMISSION_UNCERTAIN',updated_at=now() WHERE id=$1 AND status='submitting' RETURNING *", [id])).rows[0] ?? row
  }
  if (!['submitted', 'review_required'].includes(row.status) || !row.transaction_hash) return row
  const { receipt, block } = await deps.receipt(row.transaction_hash)
  if (!receipt || block < BigInt(receipt.blockNumber) + BigInt(1)) return row
  const status = receipt.status === '0x0' ? 'failed' : receipt.status === '0x1' && receiptMatches(row, receipt) ? 'confirmed' : 'review_required'
  const db = await deps.pool.connect()
  try {
    await db.query('BEGIN')
    const updated = (await db.query(`UPDATE provider_withdrawals SET status=$2,error_code=$3,updated_at=now()
      WHERE id=$1 AND status IN ('submitted','review_required') RETURNING *`, [id, status, status === 'failed' ? 'TRANSACTION_REVERTED' : status === 'review_required' ? 'RECEIPT_MISMATCH' : null])).rows[0] as WithdrawalRow | undefined
    if (updated && status === 'confirmed') {
      await db.query(`INSERT INTO user_wallet_settings(user_id,last_usdc_transfer_at) VALUES($1,now())
        ON CONFLICT(user_id) DO UPDATE SET last_usdc_transfer_at=GREATEST(user_wallet_settings.last_usdc_transfer_at,excluded.last_usdc_transfer_at),updated_at=now()`, [row.user_id])
    }
    await db.query('COMMIT')
    return updated ?? (await deps.pool.query('SELECT * FROM provider_withdrawals WHERE id=$1', [id])).rows[0]
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
}
