import test from 'node:test'
import assert from 'node:assert/strict'
import { ensurePaymentWallet } from './payment-wallet-session'

const address = '0x1111111111111111111111111111111111111111'
const base = { expectedAddress: address, initialized: () => true, getUser: async () => ({ evmSmartAccountObjects: [{ address }] }) }

test('restores a missing wallet token once before using the matching wallet', async () => {
  const calls: boolean[] = []
  assert.equal(await ensurePaymentWallet({ ...base, getToken: async ({ forceRefresh }) => { calls.push(forceRefresh); return forceRefresh ? 'test-token' : null } }), address)
  assert.deepEqual(calls, [false, true])
})

test('ready session does not force refresh; waiting SDK is not classified as expired', async () => {
  let initialized = false
  setTimeout(() => { initialized = true }, 10)
  assert.equal(await ensurePaymentWallet({ ...base, initialized: () => initialized, getToken: async ({ forceRefresh }) => { assert.equal(forceRefresh, false); return 'test-token' } }), address)
})

test('missing credentials, network errors, timeout and wallet mismatch stay distinct', async () => {
  await assert.rejects(ensurePaymentWallet({ ...base, getToken: async () => null }), /WALLET_CONNECTION_REQUIRED/)
  await assert.rejects(ensurePaymentWallet({ ...base, getToken: async () => { throw new TypeError('network') } }), /WALLET_CONNECTION_UNAVAILABLE/)
  await assert.rejects(ensurePaymentWallet({ ...base, initialized: () => false, timeoutMs: 5, getToken: async () => { assert.fail('must wait for SDK') } }), /WALLET_CONNECTION_TIMEOUT/)
  await assert.rejects(ensurePaymentWallet({ ...base, expectedAddress: 'other-wallet', getToken: async () => 'test-token' }), /WALLET_ACCOUNT_MISMATCH/)
})
