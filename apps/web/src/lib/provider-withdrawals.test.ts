import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createWithdrawal, getWithdrawal, parseWithdrawal, receiptMatches, USDC, type WithdrawalDeps, type Receipt } from './provider-withdrawals'
const require = createRequire(import.meta.url)
// Install the pinned test-only PostgreSQL runtime outside the application; never use a production DB.
const { PGlite } = require(process.env.PGLITE_TEST_MODULE || '@electric-sql/pglite')
const source = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const hash = '0x' + 'a'.repeat(64)
const input = (key = 'request-0000000001') => parseWithdrawal(recipient, '0.01', key)

test('validates precision, recipient and persistent idempotency key', () => {
  assert.equal(input().units, BigInt(10000))
  for (const amount of ['0', '-1', '1e2', '0.0000001', 'NaN', '1.']) assert.throws(() => parseWithdrawal(recipient, amount, 'request-0000000001'))
  for (const to of ['0x' + '0'.repeat(40), USDC, 'invalid']) assert.throws(() => parseWithdrawal(to, '1', 'request-0000000001'))
  assert.throws(() => parseWithdrawal(recipient, '1', 'short'))
})

test('durable withdrawal state machine with PostgreSQL constraints and mocked CDP', async () => {
  const db = new PGlite()
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY,wallet text,wallet_type text,cdp_account_name text,banned_at timestamptz);
    CREATE TABLE agent_profiles(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id));
    CREATE TABLE user_wallet_settings(user_id uuid PRIMARY KEY,last_usdc_transfer_at timestamptz,updated_at timestamptz DEFAULT now());`)
  await db.exec(readFileSync(new URL('../../../../packages/db/migrations/0013_provider_withdrawals.sql', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
  const user = randomUUID(), agent = randomUUID(), other = randomUUID(), otherAgent = randomUUID()
  await db.query("INSERT INTO users VALUES($1,$2,'server_wallet','test',NULL),($3,$2,'server_wallet','other',NULL)", [user, source, other])
  await db.query('INSERT INTO agent_profiles VALUES($1,$2),($3,$4)', [agent, user, otherAgent, other])
  const client = { query: (sql: string, args?: unknown[]) => db.query(sql, args), release() {} }
  let sends = 0, fail = false, preflightFails = false, enabled = true
  let minimum = 0.01, receipt: Receipt | null = null
  const deps: WithdrawalDeps = {
    pool: { ...client, connect: async () => client } as unknown as WithdrawalDeps['pool'], enabled: async () => enabled,
    config: async () => ({ walletTransferMinUsdc: minimum, walletTransferCooldownDays: 7 }),
    preflight: async () => { if (preflightFails) throw new Error('RPC unavailable') },
    send: async (from, to, units, id) => { sends++; assert.equal(from, source); assert.equal(to, recipient); assert.equal(units, BigInt(10000)); assert.match(id, /^[a-f0-9-]{36}$/); if (fail) throw new Error('network timeout'); return hash },
    receipt: async () => ({ receipt, block: BigInt(101) }),
  }
  try {
    enabled = false; await assert.rejects(createWithdrawal(agent, input(), deps), /TRANSFERS_DISABLED/); enabled = true
    minimum = 1; await assert.rejects(createWithdrawal(agent, input(), deps), /BELOW_MINIMUM_TRANSFER/); minimum = 0.01
    preflightFails = true; await assert.rejects(createWithdrawal(agent, input(), deps), /RPC unavailable/); preflightFails = false
    assert.equal(sends, 0)
    const row = await createWithdrawal(agent, input(), deps)
    assert.equal(row.status, 'submitted'); assert.equal(sends, 1)
    assert.equal((await createWithdrawal(agent, input(), deps)).id, row.id); assert.equal(sends, 1)
    await assert.rejects(createWithdrawal(agent, parseWithdrawal(recipient, '0.02', input().key), deps), /IDEMPOTENCY_CONFLICT/)
    await assert.rejects(createWithdrawal(agent, input('request-0000000002'), deps), /WITHDRAWAL_IN_PROGRESS/)
    await assert.rejects(getWithdrawal(otherAgent, row.id, deps), /WITHDRAWAL_NOT_FOUND/)
    assert.equal((await getWithdrawal(agent, row.id, deps)).status, 'submitted')
    receipt = { status: '0x1', blockNumber: '0x64', logs: [{ address: USDC, topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + source.slice(2).padStart(64, '0'), '0x' + recipient.slice(2).padStart(64, '0'),
    ], data: '0x2710' }] }
    assert.equal(receiptMatches(row, receipt), true)
    assert.equal(receiptMatches({ ...row, amount_units: '10001' }, receipt), false)
    assert.equal((await getWithdrawal(agent, row.id, deps)).status, 'confirmed')
    await assert.rejects(createWithdrawal(agent, input('request-0000000002'), deps), /TRANSFER_COOLDOWN/)
    await db.query('DELETE FROM user_wallet_settings WHERE user_id=$1', [user])
    fail = true
    const uncertain = await createWithdrawal(agent, input('request-0000000002'), deps)
    assert.equal(uncertain.status, 'review_required'); assert.equal(sends, 2)
    await createWithdrawal(agent, input('request-0000000002'), deps); assert.equal(sends, 2)
    await assert.rejects(createWithdrawal(agent, input('request-0000000003'), deps), /WITHDRAWAL_IN_PROGRESS/)
    await assert.rejects(db.query(`INSERT INTO provider_withdrawals(id,user_id,agent_id,idempotency_key,source_address,to_address,amount_units,status)
      VALUES($1,$2,$3,'different-request',$4,$5,1,'submitting')`, [randomUUID(), user, agent, source, recipient]))
    await db.query('UPDATE users SET banned_at=now() WHERE id=$1', [user])
    await assert.rejects(createWithdrawal(agent, input(), deps), /UNAUTHORIZED/)
    await assert.rejects(getWithdrawal(agent, row.id, deps), /WITHDRAWAL_NOT_FOUND/)
    fail = false
    const reverted = await createWithdrawal(otherAgent, input(), deps)
    receipt = { status: '0x0', blockNumber: '0x64', logs: [] }
    enabled = false
    assert.equal((await getWithdrawal(otherAgent, reverted.id, deps)).status, 'failed')
    enabled = true
    const mismatch = await createWithdrawal(otherAgent, input('request-0000000002'), deps)
    receipt = { status: '0x1', blockNumber: '0x64', logs: [] }
    assert.equal((await getWithdrawal(otherAgent, mismatch.id, deps)).status, 'review_required')
    await db.query("UPDATE users SET wallet_type='email_wallet' WHERE id=$1", [other])
    await assert.rejects(createWithdrawal(otherAgent, input(), deps), /SERVER_WALLET_REQUIRED/)
    const third = randomUUID(), thirdAgent = randomUUID()
    await db.query("INSERT INTO users VALUES($1,$2,'server_wallet','third',NULL)", [third, source])
    await db.query('INSERT INTO agent_profiles VALUES($1,$2)', [thirdAgent, third])
    let signalStarted!: () => void, releaseSend!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const wait = new Promise<void>(resolve => { releaseSend = resolve })
    let concurrentSends = 0
    const delayed = { ...deps, send: async () => { concurrentSends++; signalStarted(); await wait; return hash } }
    const first = createWithdrawal(thirdAgent, input(), delayed)
    await started
    const replay = await createWithdrawal(thirdAgent, input(), delayed)
    assert.equal(replay.status, 'submitting')
    await assert.rejects(createWithdrawal(thirdAgent, input('request-0000000002'), delayed), /WITHDRAWAL_IN_PROGRESS/)
    releaseSend()
    assert.equal((await first).id, replay.id)
    assert.equal(concurrentSends, 1)
  } finally { await db.close() }
})
