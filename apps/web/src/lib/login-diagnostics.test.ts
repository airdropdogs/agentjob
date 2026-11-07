import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginDiagnostic } from './login-diagnostics'

test('classifies errors without exposing raw SDK messages', () => {
  for (const [failure, suffix] of [
    [new Error('Failed to fetch'), 'NETWORK'],
    [new Error('Could not reach the service in time'), 'TIMEOUT'],
    [new Error('Incorrect OTP'), 'OTP_REJECTED'],
    [{ status: 429 }, 'RATE_LIMIT'],
    [{ status: 403 }, 'REJECTED'],
    [{ status: 500 }, 'SERVER'],
  ] as const) {
    assert.equal(loginDiagnostic('VERIFY', 123, failure).code, `LOGIN_VERIFY_${suffix}`)
  }
  const report = loginDiagnostic('SYNC', 12, new Error('secret-token person@example.com 123456'))
  assert.equal(report.code, 'LOGIN_SYNC_FAILED')
  assert.doesNotMatch(JSON.stringify(report), /secret-token|person@|123456/)
})

test('preserves stage, duration and HTTP status, records successes separately', () => {
  const failure = loginDiagnostic('SESSION', 123.5, { response: { status: 503 } })
  assert.equal(failure.httpStatus, 503)
  assert.equal(failure.elapsedMs, 124)
  assert.equal(failure.stage, 'SESSION')
  assert.ok(Number.isFinite(Date.parse(failure.at)))
  assert.equal(loginDiagnostic('SEND', 10).code, 'LOGIN_SEND_OK')
})
