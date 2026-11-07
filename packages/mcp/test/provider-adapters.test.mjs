import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig, executeClaude, runConnector } from '../../../apps/web/public/agentjob-connect.mjs'
import { createAdapterServer } from '../../../apps/web/public/agentjob-adapter-example.mjs'

const temporary = () => mkdtemp(join(tmpdir(), 'agentjob-adapters-'))
const base = directory => ({ AGENTJOB_API_KEY: 'platform-key', AGENTJOB_STATE_DIR: directory })

test('new adapters reject missing credentials, remote endpoints and shell wrappers', () => {
  for (const framework of ['hermes', 'custom-http']) {
    const env = { ...base(tmpdir()), AGENTJOB_FRAMEWORK: framework }
    assert.throws(() => readConfig(env), /TOKEN/)
    assert.throws(() => readConfig({ ...env, AGENTJOB_AGENT_URL: 'https://example.org/run', AGENTJOB_AGENT_TOKEN: 'secret' }), /loopback/)
    assert.equal(readConfig({ ...env, AGENTJOB_AGENT_TOKEN: 'secret' }).framework, framework)
  }
  const env = { ...base(tmpdir()), AGENTJOB_FRAMEWORK: 'claude-code' }
  assert.throws(() => readConfig(env), /CLAUDE_API_KEY/)
  assert.throws(() => readConfig({ ...env, AGENTJOB_CLAUDE_API_KEY: 'secret', AGENTJOB_CLAUDE_BIN: 'claude.cmd' }), /native/)
})

test('Claude subprocess uses isolated environment, no tools, final JSON and rejects failures', async () => {
  const directory = await temporary(), calls = []
  const fixture = join(directory, 'claude.cjs')
  const env = { AGENTJOB_CLAUDE_API_KEY: 'service-key', ANTHROPIC_API_KEY: 'private-key', AGENTJOB_API_KEY: 'platform-key', CLAUDE_CODE_OAUTH_TOKEN: 'private-token' }
  const spawnImpl = (_, args, options) => { calls.push({ args, options }); return spawn(process.execPath, [fixture, ...args], options) }
  try {
    await writeFile(fixture, `let input=''; process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Real final text'}))})`)
    for (let i = 0; i < 2; i++) assert.equal(await executeClaude({ binary: 'claude' }, [{ role: 'user', content: 'hi' }], { env, spawnImpl }), 'Real final text')
    assert.notEqual(calls[0].options.cwd, calls[1].options.cwd)
    for (const { args, options } of calls) {
      assert.equal(options.env.ANTHROPIC_API_KEY, 'service-key')
      assert.equal(options.env.AGENTJOB_API_KEY, undefined)
      assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
      assert.equal(options.shell, false)
      assert.equal(args[args.indexOf('--tools') + 1], '')
      assert.ok(args.includes('--bare'))
      assert.ok(args.includes('--strict-mcp-config'))
      assert.ok(args.includes('--no-session-persistence'))
      assert.equal(await readdir(options.cwd).catch(e => e.code), 'ENOENT')
    }
    await writeFile(fixture, `console.log(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true,result:'NOT AN ANSWER'}))`)
    await assert.rejects(executeClaude({ binary: 'claude' }, [], { env, spawnImpl }), /successful final/)
    await writeFile(fixture, `console.log('--bare --tools --no-session-persistence --strict-mcp-config')`)
    await executeClaude({ binary: 'claude' }, [], { env, spawnImpl, check: true })
    assert.deepEqual(calls.at(-1).args, ['--help'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Hermes identical prompts get distinct task scopes and failures are not delivered', async () => {
  const directory = await temporary(), controller = new AbortController(), scopes = []
  let polls = 0, deliveries = 0
  try {
    const config = readConfig({ ...base(directory), AGENTJOB_FRAMEWORK: 'hermes', AGENTJOB_AGENT_TOKEN: 'hermes-key' })
    await runConnector(config, { signal: controller.signal, retryMs: 1, log() {}, fetchImpl: async (url, options) => {
      if (url === config.gateway) {
        assert.equal(options.headers.Authorization, 'Bearer hermes-key')
        scopes.push(options.headers['X-Hermes-Session-Id'])
        assert.equal(options.headers['X-Hermes-Session-Key'], scopes.at(-1))
        assert.equal(options.headers['Idempotency-Key'], scopes.at(-1))
        assert.equal(JSON.parse(options.body).model, 'hermes-agent')
        return Response.json({ choices: [{ finish_reason: scopes.length === 1 ? 'stop' : 'error', message: { content: 'reply' } }] })
      }
      assert.equal(options.headers.Authorization, 'Bearer platform-key')
      if (url.endsWith('/me')) return Response.json({ data: { id: 'provider' } })
      if (url.endsWith('/heartbeat')) return Response.json({})
      if (url.includes('?wait=')) {
        if (++polls > 2) { controller.abort(); return Response.json({ task: null }) }
        return Response.json({ task: { id: String(polls), messages: [{ role: 'user', content: 'same opening' }] } })
      }
      deliveries++; return Response.json({})
    } })
    assert.equal(deliveries, 1)
    assert.equal(scopes.length, 2)
    assert.notEqual(scopes[0], scopes[1])
  } finally { controller.abort(); await rm(directory, { recursive: true, force: true }) }
})

test('custom adapter template real HTTP: auth, invalid inputs and end-to-end result', async () => {
  const directory = await temporary(), controller = new AbortController()
  let runs = 0, deliveries = 0
  const server = createAdapterServer({ token: 'adapter-key', run: async ({ messages, sessionId }) => {
    runs++; assert.match(sessionId, /^[a-f0-9]{64}$/); return 'Answer: ' + messages[0].content
  } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const gateway = `http://127.0.0.1:${server.address().port}/run`
  try {
    assert.equal((await fetch(gateway, { method: 'POST' })).status, 401)
    assert.equal((await fetch(gateway, { method: 'POST', headers: { Authorization: 'Bearer adapter-key' }, body: '{}' })).status, 400)
    assert.equal(runs, 0)
    const config = readConfig({ ...base(directory), AGENTJOB_FRAMEWORK: 'custom-http', AGENTJOB_AGENT_URL: gateway, AGENTJOB_AGENT_TOKEN: 'adapter-key' })
    await runConnector(config, { signal: controller.signal, log() {}, fetchImpl: async (url, options) => {
      if (url === gateway) return fetch(url, options)
      if (url.endsWith('/me')) return Response.json({ data: { id: 'provider' } })
      if (url.endsWith('/heartbeat')) return Response.json({})
      if (url.includes('?wait=')) return Response.json({ task: { id: 'task', messages: [{ role: 'user', content: 'hello' }] } })
      assert.equal(JSON.parse(options.body).text, 'Answer: hello')
      deliveries++; controller.abort(); return Response.json({})
    } })
    assert.equal(runs, 1); assert.equal(deliveries, 1)
  } finally { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) }
})

test('CLI init never overwrites, supports all frameworks and packaged runtime checks without registering', async () => {
  const directory = await temporary()
  const cli = fileURLToPath(new URL('../bin/agentjob.js', import.meta.url))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(AGENTJOB_|OPENCLAW_)/.test(key)) delete env[key]
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' })
  try {
    assert.match(invoke(['--help']).stdout, /custom-http/)
    assert.equal(invoke(['connect', '--typo']).status, 1)
    for (const framework of ['codex', 'openclaw', 'claude-code', 'hermes', 'custom-http']) {
      const path = join(directory, framework + '.env')
      const initialized = invoke(['connect', 'init', '--framework', framework, '--config', path])
      assert.equal(initialized.status, 0, initialized.stderr)
      const original = await readFile(path, 'utf8')
      assert.ok(original.includes(`AGENTJOB_FRAMEWORK=${framework}`))
      assert.equal(invoke(['connect', 'init', '--framework', framework, '--config', path]).status, 1)
      assert.equal(await readFile(path, 'utf8'), original)
      if (framework === 'custom-http') {
        await writeFile(path, original.replace('AGENTJOB_API_KEY=', 'AGENTJOB_API_KEY=fixture-key').replace('AGENTJOB_AGENT_TOKEN=', 'AGENTJOB_AGENT_TOKEN=fixture-token'))
        const check = invoke(['connect', '--config', path, '--check'])
        assert.equal(check.status, 0, check.stderr)
        assert.match(check.stdout, /No task claimed/)
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('attachment-aware OpenClaw and custom adapters preserve supported files without regenerating replies', async () => {
  for (const framework of ['openclaw', 'custom-http']) {
    const directory = await temporary(), controller = new AbortController()
    let polls = 0, runs = 0, deliveries = 0
    const attachment = { id: 'file', name: 'sample.png', contentType: 'image/png', size: 10, url: 'https://example.r2.cloudflarestorage.com/b/files/file?signature=test' }
    try {
      const config = readConfig({ ...base(directory), AGENTJOB_FRAMEWORK: framework, AGENTJOB_ATTACHMENT_TYPES: 'image/png',
        OPENCLAW_GATEWAY_TOKEN: 'local-key', OPENCLAW_AGENT_ID: 'service', AGENTJOB_AGENT_TOKEN: 'local-key' })
      await runConnector(config, { signal: controller.signal, retryMs: 1, log() {}, fetchImpl: async (url, options) => {
        if (url === config.gateway) {
          runs++
          const body = JSON.parse(options.body)
          if (framework === 'openclaw') {
            assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Describe this' }, { type: 'image_url', image_url: { url: attachment.url } }])
            return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Image reply' } }] })
          }
          assert.deepEqual(body.messages[0].attachments, [attachment])
          return Response.json({ protocolVersion: 1, taskId: body.taskId, text: 'Image reply' })
        }
        if (url.endsWith('/me')) return Response.json({ data: { id: 'provider' } })
        if (url.endsWith('/heartbeat')) { assert.deepEqual(JSON.parse(options.body).attachmentTypes, ['image/png']); return Response.json({}) }
        if (url.includes('?wait=')) {
          if (++polls > 1) { controller.abort(); return Response.json({ task: null }) }
          assert.equal(options.headers['x-agentjob-attachment-types'], 'image/png')
          return Response.json({ task: { id: 'image-message', messages: [{ role: 'user', content: 'Describe this', attachments: [attachment] }] } })
        }
        deliveries++; return Response.json({})
      } })
      assert.equal(runs, 1)
      assert.equal(deliveries, 1)
    } finally { controller.abort(); await rm(directory, { recursive: true, force: true }) }
  }
})
