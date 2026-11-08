import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindWallet } from './wallet-sync'

const wallet = '0x1234567890123456789012345678901234567890'
const reply = (status: number, data: unknown) => (async () => Response.json(data, { status })) as typeof fetch

test('rejected bindings cannot silently mark setup complete', async () => {
  for (const status of [401, 409, 500]) {
    await assert.rejects(bindWallet(wallet, 'test', reply(status, { error: 'Rejected' })), new RegExp(`WALLET_BIND_HTTP_${status}`))
  }
})
test('an already bound wallet is a successful recovery', async () => {
  await bindWallet(wallet, 'test', reply(200, { data: { wallet, updated: false } }))
})
test('successful HTTP response must confirm the expected wallet', async () => {
  await assert.rejects(bindWallet(wallet, 'test', reply(200, { data: { updated: true } })), /WALLET_BIND_INVALID/)
})
