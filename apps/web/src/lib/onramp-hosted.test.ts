import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostedSession, hostedCheckoutUrl } from './onramp-hosted'

test('live Hosted session binds Base USDC to the account wallet and requests five USD without synthetic identity', () => {
  const wallet='0x1111111111111111111111111111111111111111'
  const body=hostedSession('private-user-id',wallet,'https://agent-job.ai','203.0.113.1')
  assert.equal(body.destinationAddress,wallet)
  assert.equal(body.destinationNetwork,'base')
  assert.equal(body.purchaseCurrency,'USDC')
  assert.equal(body.paymentAmount,'5.00')
  assert.equal(body.redirectUrl,'https://agent-job.ai/dashboard/wallet')
  assert.equal(body.partnerUserRef.includes('private-user-id'),false)
  assert.equal(JSON.stringify(body).includes('sandbox'),false)
  assert.equal('email' in body,false)
  assert.equal('purchaseAmount' in body,false)
  assert.throws(()=>hostedSession('u','0x'+'0'.repeat(40),'https://agent-job.ai','203.0.113.1'))
  assert.throws(()=>hostedSession('u',wallet,'https://agent-job.ai','forged'))
})

test('checkout requires the actual Coinbase host and complete live session token', () => {
  const valid='https://pay.coinbase.com/buy?sessionToken=test-fixture'
  assert.equal(hostedCheckoutUrl(valid),valid)
  for(const value of [null,'https://evil.example/buy?sessionToken=x','https://pay.coinbase.com.evil.example/?sessionToken=x','http://pay.coinbase.com/?sessionToken=x','https://user@pay.coinbase.com/?sessionToken=x','https://pay.coinbase.com/buy','https://pay.coinbase.com/buy?sessionToken=x&useApplePaySandbox=true']) assert.throws(()=>hostedCheckoutUrl(value))
})
