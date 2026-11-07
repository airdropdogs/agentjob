#!/usr/bin/env node
/**
 * REST mock Agent: uses HTTP without MCP.
 *
 *   # Connect to production (default)
 *   AGENTJOB_API_KEY=ak_xxx pnpm run auto-reply:rest
 *
 *   # Connect to local Next.js (start apps/web with pnpm dev first)
 *   AGENTJOB_API_KEY=ak_xxx AGENTJOB_BASE_URL=http://localhost:3000 pnpm run auto-reply:rest
 *
 *   MOCK_REPLY="Acknowledged." pnpm run auto-reply:rest
 *
 *   # Heartbeat-only diagnostic; not suitable for serving customers
 *   pnpm run auto-reply:rest -- --heartbeat-only
 */

import 'dotenv/config.js'

const API_KEY = process.env.AGENTJOB_API_KEY ?? ''
const BASE_URL = (process.env.AGENTJOB_BASE_URL ?? 'https://agent-job.ai').replace(/\/$/, '')
const MOCK_REPLY =
  process.env.MOCK_REPLY ??
  'Thanks — this is an automated test reply (REST). A human agent may follow up.'
const WAIT_SEC = Math.min(
  60,
  Math.max(5, Number(process.env.AGENTJOB_WAIT_SEC) || 30),
)

const HEARTBEAT_ONLY = process.argv.includes('--heartbeat-only')

if (!API_KEY) {
  console.error('[auto-reply-rest] AGENTJOB_API_KEY is required.')
  console.error('  e.g. packages/mcp/.env: AGENTJOB_API_KEY=ak_xxx')
  process.exit(1)
}

const authHeaders = (): HeadersInit => ({
  Authorization: `Bearer ${API_KEY}`,
  Accept: 'application/json',
})

async function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function heartbeat(): Promise<void> {
  const res = await postJson('/api/agents/heartbeat')
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`heartbeat ${res.status}: ${t.slice(0, 200)}`)
  }
  const j = (await res.json()) as { next_heartbeat_in_seconds?: number }
  console.log(
    `[heartbeat] ok ${new Date().toLocaleTimeString()}` +
      (j.next_heartbeat_in_seconds != null
        ? ` (next in ~${j.next_heartbeat_in_seconds}s)`
        : ''),
  )
}

interface TaskPayload {
  id: string
  chat_id: string
  messages: Array<{ role: string; content: string }>
  user_id?: string
  is_first_chat?: boolean
  amount_usdc?: string
}

async function pollTask(): Promise<TaskPayload | null> {
  const res = await fetch(`${BASE_URL}/api/agents/tasks?wait=${WAIT_SEC}`, {
    method: 'GET',
    headers: authHeaders(),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`tasks ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = (await res.json()) as { task: TaskPayload | null }
  return data.task ?? null
}

async function submitResponse(taskId: string, text: string): Promise<void> {
  const res = await postJson(`/api/agents/tasks/${taskId}/response`, { text })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`response ${res.status}: ${t.slice(0, 200)}`)
  }
}

function startHeartbeat(): () => void {
  const tick = () => {
    heartbeat().catch((e) =>
      console.error('[heartbeat] error:', e instanceof Error ? e.message : e),
    )
  }
  tick()
  const timer = setInterval(tick, 45_000)
  return () => clearInterval(timer)
}

async function handleTask(task: TaskPayload): Promise<void> {
  const last = task.messages.at(-1)
  const raw =
    typeof last?.content === 'string'
      ? last.content
      : last?.content != null
        ? JSON.stringify(last.content)
        : ''
  const preview = raw.length > 80 ? raw.slice(0, 80) + '…' : raw
  console.log(`\n[task] ${task.id}`)
  console.log(`[task]   chat: ${task.chat_id}`)
  console.log(`[task]   user: ${preview}`)
  console.log(`[task]   amount: ${task.amount_usdc ?? '0'} USDC, first: ${task.is_first_chat}`)
  console.log(`[task]   reply: ${MOCK_REPLY}`)

  await submitResponse(task.id, MOCK_REPLY)
  console.log(`[task] submitted`)
}

async function mainLoop(): Promise<void> {
  while (true) {
    try {
      const task = await pollTask()
      if (task) {
        handleTask(task).catch((e) =>
          console.error('[task] unhandled:', e instanceof Error ? e.message : e),
        )
      }
    } catch (e) {
      console.error(
        '[poll] failed, retry in 3s:',
        e instanceof Error ? e.message : e,
      )
      await new Promise((r) => setTimeout(r, 3_000))
    }
  }
}

async function main(): Promise<void> {
  console.log('[auto-reply-rest] REST mode (no MCP)')
  console.log(`[auto-reply-rest]   base: ${BASE_URL}`)
  console.log(`[auto-reply-rest]   wait: ${WAIT_SEC}s`)
  if (!HEARTBEAT_ONLY) {
    console.log(`[auto-reply-rest]   mock: ${MOCK_REPLY}`)
  } else {
    console.log('[auto-reply-rest]   mode: heartbeat-only')
  }

  try {
    await heartbeat()
  } catch (e) {
    console.error(
      '[auto-reply-rest] first heartbeat failed — check API key and BASE_URL:',
      e instanceof Error ? e.message : e,
    )
    process.exit(1)
  }

  const stopHeartbeat = startHeartbeat()

  const shutdown = () => {
    console.log('\n[auto-reply-rest] exit')
    stopHeartbeat()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (HEARTBEAT_ONLY) {
    console.log('[auto-reply-rest] Ctrl-C to stop\n')
    await new Promise(() => {})
    return
  }

  console.log('[auto-reply-rest] polling tasks (Ctrl-C to stop)\n')
  await mainLoop()
}

main().catch((e) => {
  console.error('[auto-reply-rest] fatal:', e)
  process.exit(1)
})
