#!/usr/bin/env node
/**
 * Dev helper: auto-reply daemon via **MCP** (mock responses).
 * Heartbeat 45s, long-poll get_next_task, submit_response with MOCK_REPLY.
 *
 *   pnpm run auto-reply
 *   MOCK_REPLY="Thanks, on it." pnpm run auto-reply
 *
 * REST without MCP: pnpm run auto-reply:rest; see auto-reply-rest.ts
 */

import 'dotenv/config.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const API_KEY = process.env.AGENTJOB_API_KEY ?? ''
const BASE_URL = process.env.AGENTJOB_BASE_URL ?? 'https://agent-job.ai'
const MOCK_REPLY =
  process.env.MOCK_REPLY ??
  'Thanks — this is an automated test reply. A human agent may follow up.'

if (!API_KEY) {
  console.error('[auto-reply] AGENTJOB_API_KEY is required.')
  console.error('  Set in packages/mcp/.env: AGENTJOB_API_KEY=ak_xxx')
  process.exit(1)
}

const mcpClient = new Client(
  { name: 'agentjob-auto-reply', version: '1.0.0' },
  { capabilities: {} }
)
const transport = new StreamableHTTPClientTransport(
  new URL(`${BASE_URL}/api/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } }
)

function parseToolResult(result: unknown): unknown {
  try {
    const r = result as { content?: Array<{ text?: string }> }
    const text = r?.content?.[0]?.text
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await mcpClient.callTool({ name, arguments: args })
  return parseToolResult(result)
}

function startHeartbeat(): () => void {
  const beat = async () => {
    try {
      await callTool('heartbeat')
      console.log(`[heartbeat] ok ${new Date().toLocaleTimeString()}`)
    } catch (e) {
      console.error('[heartbeat] error:', e instanceof Error ? e.message : e)
    }
  }
  beat()
  const timer = setInterval(beat, 45_000)
  return () => clearInterval(timer)
}

interface Task {
  id: string
  chat_id: string
  messages: Array<{ role: string; content: string }>
  is_first_chat: boolean
  amount_usdc: string
}

async function handleTask(task: Task): Promise<void> {
  const lastMsg = task.messages.at(-1)?.content ?? ''
  const preview = lastMsg.length > 80 ? lastMsg.slice(0, 80) + '…' : lastMsg
  console.log(`\n[task] task ${task.id}`)
  console.log(`[task]   user: ${preview}`)
  console.log(`[task]   amount: ${task.amount_usdc} USDC, first_chat: ${task.is_first_chat}`)
  console.log(`[task]   reply: ${MOCK_REPLY}`)

  try {
    await callTool('submit_response', { task_id: task.id, text: MOCK_REPLY })
    console.log(`[task] submitted`)
  } catch (e) {
    console.error(`[task] submit failed:`, e instanceof Error ? e.message : e)
  }
}

async function mainLoop(): Promise<void> {
  while (true) {
    try {
      const result = (await callTool('get_next_task', { wait: 30 })) as { task: Task | null } | null
      if (result?.task) {
        handleTask(result.task).catch((e) =>
          console.error('[task] unhandled:', e instanceof Error ? e.message : e)
        )
      }
    } catch (e) {
      console.error('[poll] get_next_task failed, retry in 3s:', e instanceof Error ? e.message : e)
      await new Promise((r) => setTimeout(r, 3_000))
    }
  }
}

async function main(): Promise<void> {
  console.log('[auto-reply] starting...')
  console.log(`[auto-reply]   base: ${BASE_URL}`)
  console.log(`[auto-reply]   mock: ${MOCK_REPLY}`)

  await mcpClient.connect(transport)
  console.log('[auto-reply] connected to MCP')

  try {
    const profile = (await callTool('get_my_profile')) as Record<string, unknown> | null
    if (profile) {
      console.log(`[auto-reply]   agent: ${profile.name}`)
      console.log(`[auto-reply]   wallet: ${profile.wallet_address}`)
    }
  } catch {
    /* optional */
  }

  const stopHeartbeat = startHeartbeat()

  const shutdown = async () => {
    console.log('\n[auto-reply] shutting down...')
    stopHeartbeat()
    await mcpClient.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log('[auto-reply] polling (Ctrl-C to exit)\n')
  await mainLoop()
}

main().catch((e) => {
  console.error('[auto-reply] fatal:', e)
  process.exit(1)
})
