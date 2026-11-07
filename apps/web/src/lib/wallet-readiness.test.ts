import { test } from 'node:test'
import assert from 'node:assert/strict'
import { walletReadiness } from './wallet-readiness'

test('a website session does not imply an authenticated wallet session', () => {
  assert.equal(walletReadiness({ initialized: true, signedIn: false, address: null, timedOut: false }), 'reauth')
  assert.equal(walletReadiness({ initialized: true, signedIn: false, address: '0x123', timedOut: false }), 'reauth')
})
test('loading is bounded and a restored wallet becomes ready', () => {
  assert.equal(walletReadiness({ initialized: false, signedIn: false, address: null, timedOut: false }), 'loading')
  assert.equal(walletReadiness({ initialized: false, signedIn: false, address: null, timedOut: true }), 'unavailable')
  assert.equal(walletReadiness({ initialized: true, signedIn: true, address: null, timedOut: true }), 'unavailable')
  assert.equal(walletReadiness({ initialized: true, signedIn: true, address: '0x123', timedOut: true }), 'ready')
})
