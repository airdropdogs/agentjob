import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

// ── Public types (exported for SDK users) ────────────────────────────────────

export interface ChatTask {
  id: string
  chat_id: string
  messages: Array<{ role: string; content: string }>
  is_first_chat: boolean
  amount_usdc: string
  agent_name?: string
}

export interface AgentProfile {
  id: string
  name: string
  bio?: string
  description?: string
  wallet_address?: string
}

/**
 * Handler for incoming 1:1 chat tasks.
 * Receives the full task (with message history) and returns the reply text.
 * Return `null` or empty string to skip replying.
 */
export type ChatTaskHandler = (task: ChatTask) => Promise<string | null>

export interface PollingConfig {
  /** Handler for 1:1 chat tasks. If not provided, chat tasks are logged but not replied to. */
  onChatTask?: ChatTaskHandler
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseToolResult(result: unknown): unknown {
  try {
    const r = result as { content?: Array<{ text?: string }> }
    const text = r?.content?.[0]?.text
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args })
  return parseToolResult(result)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export { callTool, parseToolResult }

// ── Chat task polling loop ───────────────────────────────────────────────────

async function chatLoop(
  client: Client,
  handler: ChatTaskHandler | undefined,
): Promise<void> {
  console.error('[polling] Chat polling started (get_next_task, wait=30)')

  while (true) {
    try {
      const result = (await callTool(client, 'get_next_task', { wait: 30 })) as {
        task: ChatTask | null
      } | null

      if (!result?.task) continue

      const task = result.task
      const lastMsg = task.messages.at(-1)?.content ?? ''
      const preview = lastMsg.length > 60 ? lastMsg.slice(0, 60) + '…' : lastMsg
      const label = task.is_first_chat ? ' (first chat)' : ''
      console.error(`\n[polling] 💬 Chat task ${task.id}${label}`)
      console.error(`[polling]   user: ${preview}`)

      if (!handler) {
        console.error('[polling]   (no handler — skipped)')
        continue
      }

      try {
        const reply = await handler(task)

        if (!reply) {
          console.error('[polling]   ⚠ handler returned empty, skipping')
          continue
        }

        await callTool(client, 'submit_response', { task_id: task.id, text: reply })
        const replyPreview = reply.length > 60 ? reply.slice(0, 60) + '…' : reply
        console.error(`[polling]   ✓ replied: ${replyPreview}`)
      } catch (e) {
        console.error(
          '[polling]   ✗ handler/submit error:',
          e instanceof Error ? e.message : e,
        )
      }
    } catch (e) {
      console.error(
        '[polling] chat poll error, retry in 5s:',
        e instanceof Error ? e.message : e,
      )
      await sleep(5_000)
    }
  }
}

// ── Core polling engine (SDK API) ────────────────────────────────────────────

/**
 * Start polling incoming chat messages.
 *
 * This is the primary SDK entry point. Agents provide their own handlers
 * to process incoming tasks with their own LLM / strategy / memory / tools.
 *
 * ```typescript
 * import { Client } from '@modelcontextprotocol/sdk/client/index.js'
 * import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
 * import { startPolling, startHeartbeat } from 'agentjob'
 *
 * const client = new Client(...)
 * await client.connect(transport)
 *
 * startHeartbeat(client)
 *
 * await startPolling(client, {
 *   onChatTask: async (task) => {
 *     return await myAgent.chat(task.messages)
 *   },
 * })
 * ```
 */
export async function startPolling(
  client: Client,
  config: PollingConfig = {},
): Promise<() => void> {

  let agentId = ''
  try {
    const profile = (await callTool(client, 'get_my_profile')) as AgentProfile | null
    if (profile) {
      agentId = profile.id
      console.error(`[polling] Agent: ${profile.name} (${agentId})`)
    }
  } catch {
    console.error('[polling] Could not fetch agent profile (non-fatal)')
  }

  const loops: Promise<void>[] = []

  const enableChat = true
  if (enableChat) {
    loops.push(chatLoop(client, config.onChatTask))
  }

  if (loops.length === 0) {
    console.error('[polling] ⚠ No polling loops enabled')
  }

  const abortController = new AbortController()
  return () => {
    abortController.abort()
  }
}

// ── CLI helpers ──────────────────────────────────────────────────────────────

export interface AutoReplyConfig {
  enableChat: boolean
}

export function resolveAutoReplyConfig(): AutoReplyConfig {
  return {
    enableChat: process.env.AGENTJOB_DISABLE_CHAT !== '1',
  }
}

/**
 * Start polling from CLI (monitor mode — logs tasks but does not reply).
 * For auto-reply, use the SDK `startPolling` with custom handlers.
 */
export async function startAutoReply(
  client: Client,
  config: AutoReplyConfig,
): Promise<() => void> {
  console.error('[polling] Monitor mode — tasks are logged but not auto-replied.')
  console.error('[polling] For auto-reply, use the SDK: import { startPolling } from "agentjob"')

  return config.enableChat ? startPolling(client) : () => {}
}
