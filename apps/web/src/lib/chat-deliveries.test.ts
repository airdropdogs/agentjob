import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { Pool } from 'pg'
import { NextRequest } from 'next/server'
import * as db from './db'
import * as delivery from './provider-deliveries'
import * as policy from './attachment-policy'
import * as attachments from './chat-attachments'
import * as storage from './chat-attachment-storage'
import { inspectVideo } from './video-metadata'

const fixture = process.env.TEST_VIDEO_FIXTURE
function route(file: string, imports: Record<string, unknown>) {
  const source = readFileSync(path.resolve(__dirname, '../app/api/' + file + '/route.ts'), 'utf8')
  const exports: Record<string, any> = {}
  const require = createRequire(import.meta.url)
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (key: string) => key in imports ? imports[key] : require(key), Response, Date, console })
  return exports
}
test('MP4 metadata verifies actual duration and rejects malformed/over-limit media', { skip: !fixture }, async () => {
  const bytes = readFileSync(fixture!)
  const read = async (start: number, end: number) => new Uint8Array(bytes.subarray(start, end + 1))
  const duration = await inspectVideo(bytes.length, read, 120)
  assert.ok(duration > 1 && duration < 120)
  await assert.rejects(inspectVideo(bytes.length, read, 1), /MP4/)
  await assert.rejects(inspectVideo(20, async () => new Uint8Array(20), 120))
})

test('private R2 deliveries, limits, cancellation, progress and response replay', { skip: !process.env.TEST_DELIVERY_DATABASE_URL || !fixture, timeout: 240000 }, async () => {
  const url = new URL(process.env.TEST_DELIVERY_DATABASE_URL!)
  assert.equal(url.pathname, '/agentjob_tests')
  const schema = 'deliveries_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: url.href, max: 1 })
  const pool = new Pool({ connectionString: url.href, max: 5, options: '-c search_path=' + schema + ',public' })
  const previous = (globalThis as any).agentjobPool
  const uid = randomUUID(), aid = randomUUID(), cid = randomUUID(), tid = randomUUID(), fileId = randomUUID()
  const request = (body: unknown, auth = true) => new NextRequest('https://agent-job.ai/api/test', { method: 'POST', headers: auth ? { authorization: 'Bearer isolated' } : {}, body: JSON.stringify(body) })
  const context = { params: Promise.resolve({ taskId: tid }) }
  const imports = { '@/lib/db': db, '@/lib/agent-auth': { verifyAgentApiKey: async (key: string) => key === 'Bearer isolated' ? { id: aid } : null }, '@/lib/session': { getSession: async () => ({ userId: uid }) }, '@/lib/rate-limit': { apiKeyRateLimit: null }, '@/lib/chat-attachments': attachments, '@/lib/provider-deliveries': delivery, '@/lib/agent-reply': { isRawToolReply: () => false } }
  try {
    await admin.query('CREATE SCHEMA ' + schema)
    for (const name of ['users', 'agent_profiles', 'chats', 'messages', 'agent_chat_tasks', 'platform_config', 'agent_daily_stats', 'user_agent_free_used']) await pool.query('CREATE TABLE ' + name + ' (LIKE public.' + name + ' INCLUDING ALL)')
    for (const name of ['0005_agent_free_messages_per_user.sql', '0006_chat_attachments.sql', '0007_chat_deliveries.sql']) await pool.query(readFileSync(path.resolve(__dirname, '../../../../packages/db/migrations/' + name), 'utf8'))
    ;(globalThis as any).agentjobPool = pool
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [uid, uid + '@example.invalid'])
    await pool.query("INSERT INTO agent_profiles(id,user_id,name,api_key_hash,price_first_msg,price_subsequent) VALUES($1,$2,'Delivery test','test-only',0.01,0.01)", [aid, uid])
    await pool.query('INSERT INTO chats(id,user_id,agent_id) VALUES($1,$2,$3)', [cid, uid, aid])
    await pool.query("INSERT INTO agent_chat_tasks(id,user_id,agent_id,chat_id,messages,amount_usdc,status,timeout_at) VALUES($1,$2,$3,$4,'[]',0,'claimed',now()+interval '30 minutes')", [tid, uid, aid, cid])
    const progress = route('agents/tasks/[taskId]/progress', imports)
    assert.equal((await progress.POST(request({ seq: 1, message: 'Rendering', percent: 25 }, false), context)).status, 401)
    assert.equal((await progress.POST(request({ seq: 2, message: 'Rendering', percent: 50 }), context)).status, 200)
    assert.equal((await (await progress.POST(request({ seq: 1, message: 'Old progress' }), context)).json()).updated, false)
    assert.equal((await pool.query('SELECT progress FROM agent_chat_tasks')).rows[0].progress.percent, 50)
    const bytes = readFileSync(fixture!)
    const input = { id: fileId, name: 'test.mp4', size: bytes.length }
    const reserved = await delivery.reserveOutput(aid, tid, input)
    await delivery.reserveOutput(aid, tid, input)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_attachments')).rows[0].n, 1)
    await assert.rejects(delivery.reserveOutput(aid, tid, { ...input, id: randomUUID() }), /count limit/)
    await assert.rejects(delivery.reserveOutput(randomUUID(), tid, input), /not found/)
    const put = await fetch(reserved.uploadUrl!, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) }, signal: AbortSignal.timeout(60000) }).catch((e: any) => { throw new Error('R2 upload transport: ' + (e.cause?.code ?? e.name)) })
    assert.equal(put.status, 200)
    await pool.query("INSERT INTO platform_config(key,value) VALUES('attachment_video_max_seconds','1')")
    await assert.rejects(delivery.completeOutput(aid, tid, fileId), /MP4/)
    await pool.query("UPDATE platform_config SET value='120' WHERE key='attachment_video_max_seconds'")
    const file = await delivery.completeOutput(aid, tid, fileId)
    assert.ok(file.durationSeconds! > 1)
    assert.deepEqual(await delivery.completeOutput(aid, tid, fileId), file)
    await assert.rejects(delivery.readyOutputs(aid, randomUUID(), [fileId]), /not owned/)
    const response = route('agents/tasks/[taskId]/response', imports)
    const body = { text: '', attachmentIds: [fileId] }
    assert.equal((await response.POST(request(body), context)).status, 200)
    assert.equal((await response.POST(request(body), context)).status, 200)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n, 1)
    assert.equal((await pool.query('SELECT attachments FROM messages')).rows[0].attachments[0].id, fileId)
    const signed = await storage.downloadUrl(file.id, file.name, file.contentType, true)
    const playback = await fetch(signed, { headers: { Range: 'bytes=0-511' } })
    assert.equal(playback.status, 206)
    await playback.arrayBuffer()
    const cancel = route('chat/cancel', imports)
    assert.equal((await (await cancel.POST(request({ taskId: tid, chatId: cid }))).json()).status, 'completed')
    await pool.query("UPDATE agent_chat_tasks SET status='claimed',response_text=NULL,response_attachments='[]' WHERE id=$1", [tid])
    assert.equal((await (await cancel.POST(request({ taskId: tid, chatId: cid }))).json()).status, 'cancelled')
    assert.equal((await response.POST(request(body), context)).status, 409)
    assert.equal((await progress.POST(request({ seq: 3, message: 'Too late' }), context)).status, 409)
    await assert.rejects(delivery.reserveOutput(aid, tid, input), /no longer/)
    console.log('Verified MP4 duration:', file.durationSeconds, 'seconds; private R2 Range response: 206')
  } finally {
    await storage.deleteAttachmentObjects(fileId).catch(() => {})
    ;(globalThis as any).agentjobPool = previous
    await pool.end()
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
    await admin.end()
  }
})
