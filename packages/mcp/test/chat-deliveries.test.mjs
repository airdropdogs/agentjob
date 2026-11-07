import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapterServer } from '../../../apps/web/public/agentjob-adapter-example.mjs'
import { adapterResult, outputFiles, runConnector } from '../../../apps/web/public/agentjob-connect.mjs'

test('real custom adapter streams progress and a file-only result', async () => {
  const server = createAdapterServer({ token: 'local-only', run: async ({ reportProgress }) => {
    reportProgress({ message: 'Rendering', percent: 25 })
    return { text: '', files: [{ path: 'clip.mp4' }] }
  } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/run', { method: 'POST', headers: { authorization: 'Bearer local-only', accept: 'application/x-ndjson' }, body: JSON.stringify({ protocolVersion: 1, taskId: 'test', sessionId: 'a'.repeat(64), messages: [{ role: 'user', content: 'Video' }] }) })
    const progress = []
    const result = await adapterResult(response, p => progress.push(p))
    assert.equal(progress[0].percent, 25)
    assert.equal(result.text, '')
    assert.equal(result.files[0].path, 'clip.mp4')
    await assert.rejects(adapterResult(new Response('{"type":"progress"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {}), /Incomplete/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('output files stay within dedicated directory; retry preserves IDs without generation or credentials sent to R2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentjob-video-'))
  const config = { framework: 'custom-http', stateDir: join(root, 'state'), outputDir: join(root, 'outputs'), apiKey: 'platform-secret', platform: 'https://agent-job.ai', gateway: 'http://127.0.0.1:8787/run', token: 'local-secret' }
  await mkdir(config.outputDir)
  await writeFile(join(config.outputDir, 'clip.mp4'), 'sample')
  await writeFile(join(root, 'private.mp4'), 'private')
  const ac = new AbortController()
  let generated = 0, deliveries = 0, uploads = 0
  const ids = []
  try {
    await assert.rejects(outputFiles(config, [{ path: '../private.mp4' }]), /outside/)
    await runConnector(config, { signal: ac.signal, retryMs: 1, log: () => {}, fetchImpl: async (url, options) => {
      if (url.endsWith('/api/agents/me')) return Response.json({ data: { id: 'provider' } })
      if (url.endsWith('/heartbeat')) return Response.json({})
      if (url.includes('/tasks?')) return Response.json({ task: { id: 'request', messages: [{ role: 'user', content: 'Generate' }] } })
      if (url === config.gateway) { generated++; return Response.json({ protocolVersion: 1, taskId: 'request', text: '', files: [{ path: 'clip.mp4' }] }) }
      if (url.endsWith('/files')) {
        const body = JSON.parse(options.body)
        if (options.method === 'POST') { ids.push(body.id); return Response.json({ attachment: { contentType: 'video/mp4' }, ready: uploads > 0, uploadUrl: 'https://test.r2.cloudflarestorage.com/file' }) }
        return Response.json({})
      }
      if (url.includes('r2.cloudflarestorage.com')) { assert.equal(options.headers.Authorization, undefined); uploads++; return new Response(null, { status: 200 }) }
      if (url.endsWith('/response')) { deliveries++; if (deliveries === 1) throw new Error('Network lost'); ac.abort(); return Response.json({ submitted: true }) }
      throw new Error('Unexpected endpoint')
    } })
    assert.equal(generated, 1)
    assert.equal(uploads, 1)
    assert.equal(deliveries, 2)
    assert.equal(new Set(ids).size, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
