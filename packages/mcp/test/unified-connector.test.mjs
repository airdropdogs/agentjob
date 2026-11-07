import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig, codexEnvironment, executeCodex, runProcess, runConnector, providerStatus, checkCodex } from '../../../apps/web/public/agentjob-connect.mjs'

const temporary = () => mkdtemp(join(tmpdir(), 'agentjob-test-'))
const config = directory => ({ platform: 'http://localhost', framework: 'codex', apiKey: 'platform-secret', stateDir: join(directory, 'state'), codexHome: join(directory, 'codex'), binary: 'codex' })
const task = id => ({ id, messages: [{ role: 'user', content: 'hello' }] })

test('duplicate worker is rejected; permanent delivery rejection preserves the answer', async () => {
  const directory = await temporary()
  let executions = 0, polls = 0
  const profile = () => Response.json({ data: { id: 'agent', chatUrl: null } })
  try {
    await assert.rejects(runConnector(config(directory), { log() {},
      execute: async () => { executions++; return 'Preserved answer' },
      fetchImpl: async url => {
        if (url.endsWith('/me')) return profile()
        if (url.endsWith('/heartbeat')) {
          await assert.rejects(runConnector(config(directory), { fetchImpl: async nested => {
            assert.ok(nested.endsWith('/me')); return profile()
          } }), /Worker lock exists/)
          return Response.json({})
        }
        if (url.includes('?wait=')) { polls++; return Response.json({ task: task('one') }) }
        return new Response('{}', { status: 403 })
      },
    }), /worker stopped/)
    assert.equal(executions, 1)
    assert.equal(polls, 1)
    const files = await readdir(config(directory).stateDir)
    assert.equal(files.length, 1)
    assert.ok(files[0].endsWith('.pending.json'))
    assert.equal(JSON.parse(await readFile(join(config(directory).stateDir, files[0]), 'utf8')).text, 'Preserved answer')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('explicit framework, isolated paths and loopback Gateway are required', () => {
  const base = { AGENTJOB_API_KEY: 'secret', AGENTJOB_STATE_DIR: join(tmpdir(), 'state') }
  assert.throws(() => readConfig(base), /FRAMEWORK/)
  assert.throws(() => readConfig({ ...base, AGENTJOB_FRAMEWORK: 'codex' }), /CODEX_HOME/)
  const env = { ...base, AGENTJOB_FRAMEWORK: 'codex', AGENTJOB_CODEX_HOME: join(tmpdir(), 'dedicated') }
  assert.equal(readConfig(env).framework, 'codex')
  assert.throws(() => readConfig({ ...env, CODEX_HOME: env.AGENTJOB_CODEX_HOME }), /dedicated/)
  assert.throws(() => readConfig({ ...env, AGENTJOB_CODEX_BIN: 'codex.cmd' }), /native/)
  assert.throws(() => readConfig({ ...env, AGENTJOB_BASE_URL: 'https://secret@example.com' }), /URL/)
  assert.throws(() => readConfig({ ...base, AGENTJOB_FRAMEWORK: 'openclaw', OPENCLAW_GATEWAY_URL: 'https://example.com/v1/chat/completions' }), /loopback/)
})

test('child environment never inherits platform key, private config or unrelated credentials', () => {
  const result = codexEnvironment({ codexHome: '/dedicated' }, '/fresh', {
    PATH: '/bin', AGENTJOB_API_KEY: 'platform-secret', OPENAI_API_KEY: 'private-key', DATABASE_URL: 'db-secret',
    NODE_OPTIONS: '--require evil.js', CODEX_HOME: '/private', USERPROFILE: '/private', AGENTJOB_CODEX_API_KEY: 'service-model-key',
  })
  assert.equal(result.CODEX_API_KEY, 'service-model-key')
  assert.equal(result.CODEX_HOME, '/dedicated')
  assert.equal(result.HOME, '/fresh')
  assert.equal(result.AGENTJOB_API_KEY, undefined)
  assert.equal(result.OPENAI_API_KEY, undefined)
  assert.equal(result.DATABASE_URL, undefined)
  assert.equal(result.NODE_OPTIONS, undefined)
})

test('real subprocess: isolated task directories, stdin context, final file only and cleanup', async () => {
  const directory = await temporary()
  const fixture = join(directory, 'fake-codex.cjs')
  await writeFile(fixture, `const fs=require('fs'); let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{
    if(process.env.AGENTJOB_API_KEY || process.env.DATABASE_URL) process.exit(2);
    const args=process.argv.slice(2); const out=args[args.indexOf('-o')+1];
    fs.writeFileSync(out, 'Final reply'); console.log('PRIVATE DEBUG NOT A REPLY');
  });`)
  const calls = []
  const spawnImpl = (_, args, options) => { calls.push({ args, options }); return spawn(process.execPath, [fixture, ...args], options) }
  try {
    const service = config(directory)
    for (const content of ['first customer', 'second customer']) {
      assert.equal(await executeCodex(service, [{ role: 'user', content }], { spawnImpl, env: { AGENTJOB_API_KEY: 'platform-secret', DATABASE_URL: 'db-secret' } }), 'Final reply')
    }
    assert.notEqual(calls[0].options.cwd, calls[1].options.cwd)
    for (const call of calls) {
      assert.equal(call.options.shell, false)
      assert.ok(call.args.includes('read-only'))
      assert.ok(call.args.includes('--ignore-user-config'))
      assert.ok(call.args.includes('features.shell_tool=false'))
      assert.ok(call.args.includes('memories.use_memories=false'))
      assert.ok(!call.args.includes('first customer'))
      assert.equal(await readdir(call.options.cwd).catch(e => e.code), 'ENOENT')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('local Codex preflight checks flags and dedicated auth without inference', async () => {
  const directory = await temporary()
  const fixture = join(directory, 'fake-check.cjs')
  await writeFile(fixture, `console.log('--ignore-user-config --ignore-rules --ephemeral --output-last-message --sandbox');`)
  const calls = []
  try {
    await checkCodex(config(directory), { env: {}, spawnImpl: (_, args, options) => {
      calls.push(args); return spawn(process.execPath, [fixture], options)
    } })
    assert.deepEqual(calls, [['exec', '--help'], ['login', 'status']])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('subprocess timeout fails rather than returning debug output', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 }), /timed out/)
})

test('read-only provider status never claims tasks; invalid authentication fails closed', async () => {
  const urls = []
  const profile = await providerStatus({ platform: 'https://agent-job.ai', apiKey: 'key' }, { fetchImpl: async url => {
    urls.push(url); return Response.json({ data: { id: 'agent', chatUrl: 'https://agent-job.ai/chat/0x123', online: false } })
  } })
  assert.equal(profile.online, false)
  assert.deepEqual(urls, ['https://agent-job.ai/api/agents/me'])
  await assert.rejects(providerStatus({ platform: 'https://agent-job.ai' }, { fetchImpl: async () => new Response('upstream-secret', { status: 401 }) }), /authentication/)
})

test('delivery retry, duplicate task and failed execution never repeat generation', async () => {
  const directory = await temporary(), controller = new AbortController()
  let polls = 0, executions = 0, submissions = 0
  const bodies = [], logs = []
  try {
    await runConnector(config(directory), { signal: controller.signal, retryMs: 1, log: line => logs.push(line),
      execute: async () => { if (++executions === 2) throw new Error('private-key'); return 'Answer' },
      fetchImpl: async (url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer platform-secret')
        if (url.endsWith('/me')) return Response.json({ data: { id: 'agent', chatUrl: null } })
        if (url.endsWith('/heartbeat')) return Response.json({})
        if (url.includes('?wait=')) {
          if (++polls > 4) { controller.abort(); return Response.json({ task: null }) }
          return Response.json({ task: task(polls <= 2 ? 'one' : 'two') })
        }
        bodies.push(options.body)
        return new Response('{}', { status: ++submissions === 1 ? 503 : 200 })
      },
    })
    assert.equal(executions, 2)
    assert.equal(submissions, 2)
    assert.equal(bodies[0], bodies[1])
    assert.ok(!logs.join('').includes('private-key'))
    assert.deepEqual(await readdir(config(directory).stateDir), [])
  } finally { controller.abort(); await rm(directory, { recursive: true, force: true }) }
})

test('restart delivers persisted result before polling; changing credentials does not lose it', async () => {
  const directory = await temporary()
  let executeCount = 0
  try {
    const first = new AbortController()
    const common = async url => url.endsWith('/me') ? Response.json({ data: { id: 'same-agent', chatUrl: null } }) : Response.json({})
    await runConnector(config(directory), { signal: first.signal, retryMs: 1, log() {}, execute: async () => { executeCount++; return 'Durable answer' },
      fetchImpl: async url => {
        if (url.includes('?wait=')) return Response.json({ task: task('durable') })
        if (url.endsWith('/response')) { first.abort(); throw new Error('delivery disconnected') }
        return common(url)
      },
    })
    const files = await readdir(config(directory).stateDir)
    assert.equal(files.length, 1)
    assert.equal(JSON.parse(await readFile(join(config(directory).stateDir, files[0]), 'utf8')).text, 'Durable answer')
    const second = new AbortController(), order = []
    await runConnector({ ...config(directory), apiKey: 'rotated' }, { signal: second.signal, retryMs: 1, log() {}, execute: async () => { throw new Error('must not execute') },
      fetchImpl: async (url, options) => {
        if (url.endsWith('/response')) { order.push('delivery'); assert.equal(JSON.parse(options.body).text, 'Durable answer'); return Response.json({}) }
        if (url.includes('?wait=')) { order.push('poll'); second.abort(); return Response.json({ task: null }) }
        return common(url)
      },
    })
    assert.equal(executeCount, 1)
    assert.deepEqual(order, ['delivery', 'poll'])
    assert.deepEqual(await readdir(config(directory).stateDir), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unified OpenClaw adapter uses Gateway key only for Gateway and preserves messages', async () => {
  const directory = await temporary(), controller = new AbortController()
  try {
    await runConnector({ ...config(directory), framework: 'openclaw', gateway: 'http://localhost/v1/chat/completions', token: 'gateway-secret', agentId: 'service' }, {
      signal: controller.signal, retryMs: 1, log() {}, fetchImpl: async (url, options) => {
        if (url.endsWith('/me')) return Response.json({ data: { id: 'agent', chatUrl: null } })
        if (url.endsWith('/heartbeat')) return Response.json({})
        if (url.includes('?wait=')) return Response.json({ task: task('one') })
        if (url.includes('/v1/')) {
          assert.equal(options.headers.Authorization, 'Bearer gateway-secret')
          assert.deepEqual(JSON.parse(options.body), { model: 'openclaw:service', messages: task('one').messages, stream: false })
          return Response.json({ choices: [{ message: { content: 'OpenClaw answer' } }] })
        }
        assert.equal(options.headers.Authorization, 'Bearer platform-secret')
        assert.equal(JSON.parse(options.body).text, 'OpenClaw answer')
        controller.abort(); return Response.json({})
      },
    })
  } finally { controller.abort(); await rm(directory, { recursive: true, force: true }) }
})
