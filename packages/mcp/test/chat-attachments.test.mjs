import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'

function load(path, imports = {}, extra = {}) {
  const source = readFileSync(new URL('../../../apps/web/src/' + path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, { exports, require: name => { if (!(name in imports)) throw new Error(name); return imports[name] }, TextDecoder, Date, Response, ...extra })
  return exports
}
const policy = load('lib/attachment-policy.ts')
const id = '11111111-1111-4111-8111-111111111111'
const file = { id, name: 'photo.png', contentType: 'image/png', size: 32 }

test('file allowlist and admin bounds reject executables, SVG, zero and noninteger limits', () => {
  assert.equal(policy.fileContentType('photo.PNG'), 'image/png')
  for (const name of ['script.svg', 'page.html', 'run.exe', 'archive.zip']) assert.equal(policy.fileContentType(name), null)
  for (const value of ['0', '11', '1.5', 'NaN', '-1']) assert.equal(policy.validAttachmentSetting('attachment_max_files', value), false)
  assert.equal(policy.validAttachmentSetting('attachment_max_files', '4'), true)
  assert.equal(policy.matchesFileHeader('image/png', Buffer.from('<script>')), false)
  assert.equal(policy.matchesFileHeader('image/png', Buffer.from('89504e470d0a1a0a', 'hex')), true)
  assert.equal(policy.matchesFileHeader('text/plain', Buffer.from([255, 0])), false)
})

function service({ owner = 'u', agent = 'a', chat = 'c', expired = false, supported = ['image/png'] } = {}) {
  let signs = 0
  const row = { ...file, content_type: file.contentType, state: 'ready', expires_at: new Date(Date.now() + (expired ? -10000 : 10000)) }
  const pool = { async query(sql, args) {
    if (sql.includes('platform_config')) return { rows: [] }
    if (sql.includes('user_id=$2')) return { rows: args[1] === owner && args[2] === agent && args[3] === chat ? [row] : [] }
    return { rows: expired ? [] : [row] }
  } }
  const module = load('lib/chat-attachments.ts', {
    './db': { getPool: () => pool }, './rate-limit': { getRedisOptional: () => ({ get: async () => JSON.stringify(supported) }) },
    './attachment-policy': policy, './chat-attachment-storage': { attachmentsConfigured: () => true, downloadUrl: async () => { signs++; return 'https://private.example/file' } },
  })
  return { ...module, signed: () => signs }
}
const message = { role: 'user', content: 'Describe this', attachments: [file] }

test('ownership binds files to customer, Agent and conversation; no URL is issued on rejection', async () => {
  for (const overrides of [{ owner: 'other' }, { agent: 'other' }, { chat: 'other' }]) {
    const s = service(overrides)
    await assert.rejects(s.providerAttachments([message], 'u', 'a', 'c'), /unavailable/)
    assert.equal(s.signed(), 0)
  }
})
test('unsupported, expired, forged metadata and over-limit files reject before delivery', async () => {
  await assert.rejects(service({ supported: [] }).validateChatAttachments([message], 'u', 'a', 'c'), /No new payment/)
  await assert.rejects(service({ expired: true }).validateChatAttachments([message], 'u', 'a', 'c'), /expired/)
  await assert.rejects(service().validateChatAttachments([{ ...message, attachments: [{ ...file, name: 'forged.png' }] }], 'u', 'a', 'c'), /unavailable/)
  await assert.rejects(service().validateChatAttachments([{ ...message, attachments: Array(5).fill(file) }], 'u', 'a', 'c'), /Invalid/)
})
test('expired historical file does not block a new text message; provider sees an explicit notice', async () => {
  const result = await service({ expired: true }).providerAttachments([message, { role: 'user', content: 'Continue in text' }], 'u', 'a', 'c')
  assert.match(result[0].content, /Earlier attachment no longer available/)
  assert.equal(result[0].attachments, undefined)
  assert.equal(result[1].content, 'Continue in text')
})
test('ready files get fresh URLs, and injected client URL is never forwarded', async () => {
  const s = service()
  const result = await s.providerAttachments([{ ...message, attachments: [{ ...file, url: 'http://localhost/secret' }] }], 'u', 'a', 'c')
  assert.equal(result[0].attachments[0].url, 'https://private.example/file')
  assert.equal(s.signed(), 1)
})

test('an older polling worker cannot silently omit the current attachment', async () => {
  const s = service()
  await assert.rejects(s.providerAttachments([message], 'u', 'a', 'c', []), /cannot be omitted/)
  assert.equal(s.signed(), 0)
})

test('R2 finalize rejects size/type/header mismatch and uses conditional immutable copy', async () => {
  for (const fault of ['size', 'type', 'header', null]) {
    const commands = []
    class Command { constructor(input) { this.input = input } }
    class Head extends Command {} class Get extends Command {} class Copy extends Command {} class Delete extends Command {}
    const storage = load('lib/chat-attachment-storage.ts', {
      '@aws-sdk/client-s3': { S3Client: class { async send(command) {
        commands.push(command)
        if (command instanceof Head) return { ContentLength: fault === 'size' ? 999 : 32, ContentType: fault === 'type' ? 'text/html' : 'image/png', ETag: 'version1' }
        if (command instanceof Get) return { Body: { transformToByteArray: async () => fault === 'header' ? Buffer.from('bad') : Buffer.from('89504e470d0a1a0a', 'hex') } }
        return {}
      } }, HeadObjectCommand: Head, GetObjectCommand: Get, CopyObjectCommand: Copy, DeleteObjectCommand: Delete, PutObjectCommand: Command },
      '@aws-sdk/s3-request-presigner': { getSignedUrl: async () => '' }, './attachment-policy': policy, './video-metadata': { inspectVideo: async () => { throw new Error('Unexpected video') } },
    }, { process: { env: { CHAT_ATTACHMENTS_ENABLED: 'true', R2_ACCOUNT_ID: 'a', R2_BUCKET_NAME: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' } } })
    if (fault) { await assert.rejects(storage.finalizeObject(id, 'image/png', 32)); assert.equal(commands.some(c => c instanceof Copy), false) }
    else {
      await storage.finalizeObject(id, 'image/png', 32)
      const copy = commands.find(c => c instanceof Copy)
      assert.equal(copy.input.CopySourceIfMatch, 'version1')
      assert.equal(copy.input.Key, `files/${id}`)
      assert.equal(commands.at(-1) instanceof Copy, true)
    }
  }
})

function uploadRoute({ signedIn = true, quota = 0, allowed = true, owner = true, state = 'pending' } = {}) {
  let signs = 0, finalized = 0
  const calls = []
  const client = { release() {}, async query(sql, args) {
    calls.push({ sql, args })
    if (sql.includes('FROM agent_profiles')) return { rows: [{ id: 'agent' }] }
    if (sql.includes('FROM chats')) return { rows: [] }
    if (sql.includes('FROM users')) return { rows: [{ banned_at: null }] }
    if (sql.includes('sum(size)')) return { rows: [{ bytes: quota, count: 0 }] }
    if (sql.includes('SELECT * FROM chat_attachments')) {
      assert.equal(args[1], 'user')
      return { rows: owner ? [{ ...file, content_type: file.contentType, state }] : [] }
    }
    return { rows: [] }
  } }
  const route = load('app/api/chat/attachments/route.ts', {
    zod: createRequire(new URL('../../../apps/web/package.json', import.meta.url))('zod'),
    '@/lib/session': { getSession: async () => signedIn ? { userId: 'user' } : {} },
    '@/lib/db': { getPool: () => ({ query: client.query, connect: async () => client }) },
    '@/lib/chat-attachments': { attachmentCapabilities: async () => allowed ? ['image/png'] : [], attachmentLimits: async () => ({ attachment_max_mb: 10, attachment_daily_mb: 50, attachment_retention_days: 7 }) },
    '@/lib/attachment-policy': policy,
    '@/lib/chat-attachment-storage': { attachmentsConfigured: () => true,
      uploadUrl: async () => { signs++; return 'https://storage.example/upload' }, downloadUrl: async () => { signs++; return 'https://storage.example/download' }, finalizeObject: async () => { finalized++ } },
  }, { crypto: webcrypto })
  return { ...route, calls, signed: () => signs, finalized: () => finalized }
}
const uploadRequest = () => ({ json: async () => ({ chatId: id, agentWallet: '0x' + '1'.repeat(40), name: 'photo.png', size: 32 }) })
test('upload HTTP endpoints reject unsigned-in, unsupported and exhausted users without signing R2 access', async () => {
  for (const [options, status] of [[{ signedIn: false }, 401], [{ quota: 50 * 1048576 }, 429]]) {
    const route = uploadRoute(options)
    assert.equal((await route.POST(uploadRequest())).status, status)
    assert.equal(route.signed(), 0)
    assert.equal(route.calls.some(c => c.sql.includes('INSERT INTO')), false)
  }
})

test('platform uploads stay available without connector declarations or verification badges', async () => {
  const route = uploadRoute({ allowed: false })
  const response = await route.GET({ nextUrl: new URL('https://agent-job.ai/api/chat/attachments?agentWallet=0x' + '1'.repeat(40)) })
  const body = await response.json()
  assert.equal(body.enabled, true)
  assert.ok(body.acceptedTypes.includes('image/png'))
  assert.ok(body.acceptedTypes.includes('application/pdf'))
  assert.equal((await route.POST(uploadRequest())).status, 200)
})
test('upload quota reservation commits once; download is private and repeat finalize does not overwrite', async () => {
  const route = uploadRoute()
  assert.equal((await route.POST(uploadRequest())).status, 200)
  assert.equal(route.calls.filter(c => c.sql === 'COMMIT').length, 1)
  assert.equal(route.calls.filter(c => c.sql.includes('pg_advisory_xact_lock')).length, 1)
  const other = uploadRoute({ owner: false })
  assert.equal((await other.GET({ nextUrl: new URL('https://agent-job.ai/api/chat/attachments?id=' + id) })).status, 404)
  assert.equal(other.signed(), 0)
  const ready = uploadRoute({ state: 'ready' })
  assert.equal((await ready.PATCH({ json: async () => ({ id }) })).status, 200)
  assert.equal(ready.finalized(), 0)
})
