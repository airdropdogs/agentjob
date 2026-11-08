import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedCdpPath, cdpProxyUrl } from './cdp-proxy-path'

test('new wallet secret initialization uses the SDK PUT method through the relay', () => {
  const path = '/platform/v2/embedded-wallet-api/projects/project/end-users/user/wallet-secrets'
  assert.equal(allowedCdpPath(path, 'PUT', 'project'), true)
  assert.equal(cdpProxyUrl('https://api.cdp.coinbase.com' + path, 'PUT', 'https://agent-job.ai', 'project'), 'https://agent-job.ai/api/cdp' + path)
  for (const method of ['POST', 'GET', 'DELETE']) assert.equal(allowedCdpPath(path, method, 'project'), false)
  assert.equal(allowedCdpPath(path, 'PUT', 'other'), false)
  assert.equal(allowedCdpPath(path + '/export', 'PUT', 'project'), false)
  assert.equal(allowedCdpPath(path.replace('wallet-secrets', 'evm'), 'PUT', 'project'), false)
})

test('relay matches only this project and explicitly permitted methods and routes', () => {
  const path = '/platform/v2/embedded-wallet-api/projects/project/auth/init'
  assert.equal(allowedCdpPath(path, 'POST', 'project'), true)
  assert.equal(allowedCdpPath(path, 'GET', 'project'), false)
  assert.equal(allowedCdpPath(path, 'POST', 'other'), false)
  assert.equal(allowedCdpPath(path + '/anything', 'POST', 'project'), false)
  assert.equal(cdpProxyUrl('https://api.cdp.coinbase.com' + path, 'POST', 'https://agent-job.ai', 'project'), 'https://agent-job.ai/api/cdp' + path)
  for (const url of ['https://evil.example' + path, 'https://api.cdp.coinbase.com' + path + '?secret=x']) {
    assert.equal(cdpProxyUrl(url, 'POST', 'https://agent-job.ai', 'project'), null)
  }
})

test('wallet broadcast and export are outside this login trial', () => {
  for (const suffix of ['evm/export', 'evm/send/transaction', 'solana/send/transaction']) {
    assert.equal(allowedCdpPath('/platform/v2/embedded-wallet-api/projects/project/end-users/user/' + suffix, 'POST', 'project'), false)
  }
})
