import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticEndpoint, observeLoginFetch, type LoginRequest } from './login-network-diagnostics'

test('redacts credentials, queries and dynamic path segments; excludes unrelated endpoints', () => {
  assert.equal(diagnosticEndpoint('https://secret:password@api.cdp.coinbase.com/platform/v2/users/person@example.com?token=secret#otp', 'https://agent-job.ai'),
    'https://api.cdp.coinbase.com/platform/v2/users/[redacted]')
  assert.equal(diagnosticEndpoint('https://evilcoinbase.com/token', 'https://agent-job.ai'), null)
  assert.equal(diagnosticEndpoint('/api/chat?key=secret', 'https://agent-job.ai'), null)
})

test('captures pending and HTTP results without consuming or replacing responses', async () => {
  const response = new Response('private response', { status: 429 })
  let resolve!: (value: Response) => void
  const original: typeof fetch = () => new Promise(r => { resolve = r })
  const target = { fetch: original }
  const events: LoginRequest[] = []
  const stop = observeLoginFetch(target, 'https://agent-job.ai', () => 'SEND', e => events.push(e))
  const pending = target.fetch('https://api.cdp.coinbase.com/platform/v2/auth/email')
  assert.equal(events[0].code, 'LOGIN_REQUEST_PENDING')
  resolve(response)
  assert.equal(await pending, response)
  assert.equal(response.bodyUsed, false)
  assert.equal(events[1].httpStatus, 429)
  stop()
  assert.equal(target.fetch, original)
})

test('preserves thrown errors while excluding secret error text', async () => {
  const failure = new TypeError('Failed to fetch secret-token')
  const target = { fetch: (async () => { throw failure }) as typeof fetch }
  const events: LoginRequest[] = []
  const stop = observeLoginFetch(target, 'https://agent-job.ai', () => 'VERIFY', e => events.push(e))
  await assert.rejects(target.fetch('/api/auth/session'), e => e === failure)
  assert.equal(events[1].code, 'LOGIN_REQUEST_NETWORK')
  assert.doesNotMatch(JSON.stringify(events), /secret-token/)
  stop()
})
