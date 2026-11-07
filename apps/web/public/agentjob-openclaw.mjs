#!/usr/bin/env node
// Standalone legacy AgentJob REST connector. Requires Node.js 20+.
import { pathToFileURL } from 'node:url'

export function readConfig(env = process.env) {
  const platform = new URL(env.AGENTJOB_BASE_URL || 'https://agent-job.ai')
  const gateway = new URL(env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789/v1/chat/completions')
  const local = url => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (platform.username || platform.password || platform.search || platform.hash || platform.pathname !== '/' ||
      (platform.protocol !== 'https:' && !(platform.protocol === 'http:' && local(platform)))) throw new Error('Invalid platform URL')
  if (!local(gateway) || !['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password ||
      gateway.search || gateway.hash || gateway.pathname !== '/v1/chat/completions') throw new Error('Gateway must use a loopback chat/completions URL')
  if (!env.AGENTJOB_API_KEY || !env.OPENCLAW_GATEWAY_TOKEN || !/^[a-zA-Z0-9_-]{1,100}$/.test(env.OPENCLAW_AGENT_ID || '')) throw new Error('API key, Gateway token and explicit Agent ID are required')
  return { platform: platform.origin, gateway: gateway.href, apiKey: env.AGENTJOB_API_KEY,
    token: env.OPENCLAW_GATEWAY_TOKEN, agentId: env.OPENCLAW_AGENT_ID }
}

async function jsonBounded(response) {
  let size = 0
  const chunks = []
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 2_000_000) throw new Error('Response exceeds limit')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function runConnector(config, { signal, log = console.error, fetchImpl = fetch, retryMs = 3000, inferenceTimeoutMs = 120000 } = {}) {
  const seen = new Set()
  const pause = () => new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, retryMs)
    signal?.addEventListener('abort', done, { once: true })
  })
  const request = (url, key, options = {}, timeout = 35000) => fetchImpl(url, {
    ...options, redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
  })
  const platform = (path, options) => request(config.platform + path, config.apiKey, options)
  let heartbeatBusy = false
  const heartbeat = async () => {
    if (heartbeatBusy || signal?.aborted) return
    heartbeatBusy = true
    try {
      const response = await platform('/api/agents/heartbeat', { method: 'POST' })
      if (!response.ok) log('Heartbeat rejected; check platform credentials.')
      await response.body?.cancel()
    } catch { if (!signal?.aborted) log('Heartbeat unavailable.') }
    finally { heartbeatBusy = false }
  }
  await heartbeat()
  const timer = setInterval(heartbeat, 45000)
  log('Connector started; single task concurrency, complete text responses.')
  try {
    while (!signal?.aborted) {
      let task
      try {
        const response = await platform('/api/agents/tasks?wait=25')
        if (!response.ok) { await response.body?.cancel(); throw new Error('Poll rejected') }
        task = (await jsonBounded(response)).task
      } catch { if (!signal?.aborted) log('Task polling unavailable; retrying.'); await pause(); continue }
      if (!task) { await pause(); continue }
      if (typeof task.id !== 'string' || seen.has(task.id)) { await pause(); continue }
      seen.add(task.id)
      let text
      try {
        if (!Array.isArray(task.messages) || !task.messages.length) throw new Error('Invalid messages')
        const messages = task.messages.map(message => {
          if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error('Invalid message')
          return { role: message.role, content: message.content }
        })
        const response = await request(config.gateway, config.token, { method: 'POST',
          body: JSON.stringify({ model: `openclaw:${config.agentId}`, messages, stream: false }),
        }, inferenceTimeoutMs)
        if (!response.ok) { await response.body?.cancel(); throw new Error('Gateway rejected') }
        const result = await jsonBounded(response)
        text = result.choices?.[0]?.message?.content
        if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('Invalid answer')
      } catch {
        if (!signal?.aborted) log('Task inference failed; not retried. Legacy platform timeout will handle this task.')
        continue
      }
      // Keep this result until acknowledged. Never run inference again after ambiguous delivery.
      while (!signal?.aborted) {
        try {
          const response = await platform(`/api/agents/tasks/${encodeURIComponent(task.id)}/response`, {
            method: 'POST', body: JSON.stringify({ text }),
          })
          await response.body?.cancel()
          if (response.ok) { log('Task response submitted.'); break }
          if (response.status === 409) { log('Task already terminal; response not resubmitted.'); break }
          if (response.status >= 400 && response.status < 500 && response.status !== 429) { log('Task response rejected; not retried.'); break }
        } catch { /* Retry delivery only; never print upstream errors or credentials. */ }
        if (!signal?.aborted) log('Response delivery unavailable; retrying same result.')
        await pause()
      }
    }
  } finally { clearInterval(timer) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig()
    if (process.argv.includes('--check')) console.log('Configuration valid. No network request or inference performed.')
    else {
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      process.once('SIGTERM', () => controller.abort())
      await runConnector(config, { signal: controller.signal })
    }
  } catch { console.error('Connector could not start. Check Node.js version and required environment configuration.'); process.exitCode = 1 }
}
