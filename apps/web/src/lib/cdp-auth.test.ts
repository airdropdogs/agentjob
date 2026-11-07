import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyCdpIdentity } from './cdp-auth'

const wallet = '0x0000000000000000000000000000000000000001'
const verified = { userId: 'cdp-user', authenticationMethods: [{ type: 'email', email: 'owner@example.com' }], evmSmartAccounts: [wallet] }
const request = () => new Request('http://localhost', { headers: { Authorization: 'Bearer token-for-test' } })

test('email-only spoof cannot reach the token verifier', async () => {
  let called = false
  await assert.rejects(verifyCdpIdentity(new Request('http://localhost'), 'owner@example.com', wallet, async () => {
    called = true
    return verified
  }), /Authentication required/)
  assert.equal(called, false)
})

test('invalid tokens, another email and unowned wallets are rejected', async () => {
  await assert.rejects(verifyCdpIdentity(request(), 'owner@example.com', wallet, async () => { throw new Error('invalid token') }), /invalid token/)
  await assert.rejects(verifyCdpIdentity(request(), 'admin@example.com', wallet, async () => verified), /Identity mismatch/)
  await assert.rejects(verifyCdpIdentity(request(), 'owner@example.com', '0x0000000000000000000000000000000000000002', async () => verified), /Wallet ownership mismatch/)
})

test('verified identity is derived from server response and accepts account object representations', async () => {
  const identity = await verifyCdpIdentity(request(), 'OWNER@example.com', wallet, async token => {
    assert.equal(token, 'token-for-test')
    return { ...verified, evmSmartAccounts: [], evmSmartAccountObjects: [{ address: wallet }] }
  })
  assert.deepEqual(identity, { userId: 'cdp-user', email: 'owner@example.com', wallets: [wallet], wallet })
})
