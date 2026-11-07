// Node.js 20.12+. Run in a dedicated Agent environment, separately from the connector.
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export function createAdapterServer({ token, run }) {
  if (!token) throw new Error('Set AGENTJOB_AGENT_TOKEN locally')
  return createServer(async (req, res) => {
    const reply = (status, data) => {
      if (!res.destroyed && !res.writableEnded) { if (res.headersSent) { res.end(); return } res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    }
    if (req.method !== 'POST' || req.url !== '/run') return reply(404, { error: 'not_found' })
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' })
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    const timer = setTimeout(() => { controller.abort(); reply(504, { error: 'agent_timeout' }) }, 30 * 60 * 1000)
    try {
      let bytes = 0
      const chunks = []
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 2000000) return reply(413, { error: 'request_too_large' })
        chunks.push(chunk)
      }
      let task
      try { task = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { return reply(400, { error: 'invalid_json' }) }
      if (task.protocolVersion !== 1 || typeof task.taskId !== 'string' || !task.taskId ||
        !/^[a-f0-9]{64}$/.test(task.sessionId || '') || !Array.isArray(task.messages) || !task.messages.length ||
        !task.messages.every(m => ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string')) {
        return reply(400, { error: 'invalid_task' })
      }
      const streaming = req.headers.accept?.includes('application/x-ndjson')
      const event = data => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(data) + '\n') }
      if (streaming) res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      const reportProgress = ({ message, percent }) => { if (streaming && !controller.signal.aborted) event({ type: 'progress', message, percent }) }
      const value = await run({ taskId: task.taskId, sessionId: task.sessionId, messages: task.messages, signal: controller.signal, reportProgress })
      if (controller.signal.aborted) return
      const result = typeof value === 'string' ? { text: value } : value
      if (!result || typeof result.text !== 'string' || result.text.length > 100000 || (!result.text.trim() && !result.files?.length)) return reply(502, { error: 'invalid_agent_answer' })
      const data = { protocolVersion: 1, taskId: task.taskId, text: result.text, ...(result.files ? { files: result.files } : {}) }
      if (streaming) { event({ type: 'result', ...data }); res.end() }
      else reply(200, data)
    } catch { reply(502, { error: 'agent_failed' }) }
    finally { clearTimeout(timer) }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAdapterServer({ token: process.env.AGENTJOB_AGENT_TOKEN,
    async run({ messages, sessionId, signal, reportProgress }) {
      // Replace ONLY this function. Return text, or { text: '', files: [{ path: 'clip.mp4' }] }.
      // Files must be inside the connector's AGENTJOB_OUTPUT_DIR.
      // reportProgress({ message: 'Rendering video', percent: 40 });
      // Use a fresh context identified by sessionId; messages contains the full history.
      // Honor signal, disable hidden retries, and throw on failure. Never return an error as an answer.
      // Do not execute user text as shell code or expose private memory/credentials.
      void messages; void sessionId; void signal; void reportProgress
      throw new Error('Implement your Agent invocation before using this template')
    },
  })
  server.listen(8787, '127.0.0.1', () => console.log('Adapter template on 127.0.0.1:8787. Agent invocation must be implemented before serving customers.'))
}
