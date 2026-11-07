import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPaymentBalance } from './wallet-funding'

test('funding compares exact amounts and accepts sufficient or equal balances', () => {
  assert.doesNotThrow(() => assertPaymentBalance({ smartWallet: '0xAb', usdcRaw: '100000' }, '0xab', '100000'))
  assert.throws(() => assertPaymentBalance({ smartWallet: '0xab', usdcRaw: '99999' }, '0xab', '100000'), /Insufficient/)
  assert.doesNotThrow(() => assertPaymentBalance({ smartWallet: '0xab', usdcRaw: '90000' }, '0xab', '90000'))
})

test('unknown, malformed or different-wallet balances must not trigger funding as if zero', () => {
  for (const balance of [null, { smartWallet: 'other', usdcRaw: '0' }, { smartWallet: 'payer', usdcRaw: 'NaN' }, { smartWallet: 'payer' }]) {
    assert.throws(() => assertPaymentBalance(balance, 'payer', '100000'), /Could not verify/)
  }
})
