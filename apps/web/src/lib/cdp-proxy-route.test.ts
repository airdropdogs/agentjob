import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GET, POST, PUT } from '../app/api/cdp/[...path]/route'

test('relay rejects disabled access, wrong projects, cross-origin and oversized bodies before upstream', async () => {
  const previous = process.env.CDP_PROXY_TRIAL_ENABLED
  const project = process.env.NEXT_PUBLIC_CDP_PROJECT_ID
  process.env.NEXT_PUBLIC_CDP_PROJECT_ID = 'test-project'
  const url = 'https://agent-job.ai/api/cdp/platform/v2/embedded-wallet-api/projects/test-project/auth/init'
  try {
    process.env.CDP_PROXY_TRIAL_ENABLED = 'false'
    assert.equal((await GET(new Request(url))).status, 503)
    process.env.CDP_PROXY_TRIAL_ENABLED = 'true'
    assert.equal((await GET(new Request(url.replace('test-project', 'other')))).status, 404)
    assert.equal((await POST(new Request(url, { method: 'POST', headers: { origin: 'https://evil.example' } }))).status, 403)
    assert.equal((await POST(new Request(url, { method: 'POST', headers: { origin: 'https://agent-job.ai', 'content-type': 'application/json' }, body: 'x'.repeat(131073) }))).status, 413)
    const walletUrl = url.replace('auth/init', 'end-users/user/wallet-secrets')
    assert.equal((await PUT(new Request(walletUrl, { method: 'PUT', headers: { origin: 'https://evil.example' } }))).status, 403)
    assert.equal((await PUT(new Request(walletUrl, { method: 'PUT', headers: { origin: 'https://agent-job.ai', 'content-type': 'application/json' }, body: 'x'.repeat(131073) }))).status, 413)
    assert.equal((await PUT(new Request(walletUrl, { method: 'PUT', headers: { origin: 'https://agent-job.ai', 'content-type': 'application/json' }, body: 'invalid' }))).status, 400)
  } finally {
    if (previous === undefined) delete process.env.CDP_PROXY_TRIAL_ENABLED
    else process.env.CDP_PROXY_TRIAL_ENABLED = previous
    if (project === undefined) delete process.env.NEXT_PUBLIC_CDP_PROJECT_ID
    else process.env.NEXT_PUBLIC_CDP_PROJECT_ID = project
  }
})
