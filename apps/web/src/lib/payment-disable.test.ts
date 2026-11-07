import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

test('disabled payments block wallet preflight before credentials or database access', async () => {
  const previous = process.env.ENABLE_REAL_PAYMENTS
  try {
    delete process.env.ENABLE_REAL_PAYMENTS
    const { POST } = await import('../app/api/wallet/transfer/validate/route')
    const response = await POST(new NextRequest('http://localhost/api/wallet/transfer/validate', { method: 'POST' }))
    assert.equal(response.status, 503)
    assert.match((await response.json()).error, /temporarily unavailable/)

  } finally {
    if (previous === undefined) delete process.env.ENABLE_REAL_PAYMENTS
    else process.env.ENABLE_REAL_PAYMENTS = previous
  }
})
