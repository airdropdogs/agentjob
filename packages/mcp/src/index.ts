import { Client }                         from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport }  from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server }                         from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport }           from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { startHeartbeat } from './heartbeat.js'
export { startHeartbeat } from './heartbeat.js'
import { startAutoReply, resolveAutoReplyConfig, parseToolResult } from './auto-reply.js'
export { startPolling } from './auto-reply.js'
export type {
  AutoReplyConfig,
  PollingConfig,
  ChatTask,
  ChatTaskHandler,
  AgentProfile,
} from './auto-reply.js'

function buildPlatformClient(apiKey: string | null, baseUrl: string) {
  const client = new Client(
    { name: 'agentjob-bridge', version: '0.1.0' },
    { capabilities: {} }
  )
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/api/mcp`),
    { requestInit: { headers } }
  )
  return { client, transport }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Print which agent this API key belongs to (MCP tool `get_my_profile`).
 * CLI: `AGENTJOB_API_KEY=ak_xxx npx agentjob --whoami`
 */
export async function runWhoami(apiKey: string, baseUrl: string): Promise<void> {
  const { client, transport } = buildPlatformClient(apiKey, baseUrl)
  await client.connect(transport)
  try {
    const result = await client.callTool({ name: 'get_my_profile', arguments: {} })
    const parsed = parseToolResult(result) as Record<string, unknown> | null
    if (!parsed) {
      const r = result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined
      const err = r?.content?.map((c) => c.text).join('').trim() || 'could not parse profile'
      throw new Error(err)
    }
    console.log(JSON.stringify(parsed, null, 2))
  } finally {
    await client.close().catch(() => {})
  }
}

/** Daemon: heartbeat only, no stdio MCP (e.g. IDE closed). npx agentjob --daemon */
export async function runDaemon(apiKey: string, baseUrl: string) {
  const { client, transport } = buildPlatformClient(apiKey, baseUrl)
  await client.connect(transport)
  console.error('[agentjob daemon] Connected — heartbeat every 45s. Agent will stay online.')
  console.error('[agentjob daemon] Press Ctrl-C to stop.')

  const stopHeartbeat = startHeartbeat(client)

  const keepAlive = setInterval(() => {}, 60_000)

  const shutdown = async () => {
    clearInterval(keepAlive)
    stopHeartbeat()
    await client.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/** Auto-reply: heartbeat + polling for chat. npx agentjob --auto-reply */
export async function runAutoReply(apiKey: string, baseUrl: string) {
  const { client, transport } = buildPlatformClient(apiKey, baseUrl)
  await client.connect(transport)

  const config = resolveAutoReplyConfig()

  console.error('[agentjob] Connected — auto-reply mode')
  console.error(`[agentjob]   Chat polling  : ${config.enableChat ? 'ON' : 'OFF'}`)
  console.error('[agentjob] Press Ctrl-C to stop.\n')

  const stopHeartbeat = startHeartbeat(client)
  const stopAutoReply = await startAutoReply(client, config)

  const keepAlive = setInterval(() => {}, 60_000)

  const shutdown = async () => {
    console.error('\n[agentjob] Shutting down auto-reply...')
    clearInterval(keepAlive)
    stopAutoReply()
    stopHeartbeat()
    await client.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// ── Bridge with Sampling-based auto-polling ──────────────────────────────────

interface AgentProfileInfo {
  name: string
  bio?: string
  description?: string
  skills?: string[]
  agentType?: string
}

function buildSamplingSystemPrompt(profile: AgentProfileInfo | null): string {
  const parts: string[] = []
  parts.push('You are an AI agent on the AgentJob platform, providing paid services to users.')

  if (profile) {
    if (profile.name) parts.push(`Your name is "${profile.name}".`)
    if (profile.bio) parts.push(`Your bio: ${profile.bio}`)
    if (profile.description) parts.push(`Your description: ${profile.description}`)
    if (profile.skills?.length) parts.push(`Your skills: ${profile.skills.join(', ')}`)
    if (profile.agentType) parts.push(`Your agent type: ${profile.agentType}`)
  }

  parts.push(
    'Rules:',
    '- Reply in the same language as the user.',
    '- Be specific, helpful, and directly address the user\'s question.',
    '- Use your full AI capabilities.',
    '- Keep responses concise but complete.',
  )

  return parts.join('\n')
}

async function fetchAgentProfile(platformClient: Client): Promise<AgentProfileInfo | null> {
  try {
    const result = await platformClient.callTool({ name: 'get_my_profile', arguments: {} })
    const parsed = parseToolResult(result) as Record<string, unknown> | null
    if (!parsed) return null
    return {
      name: (parsed.name as string) ?? '',
      bio: (parsed.bio as string) ?? undefined,
      description: (parsed.description as string) ?? undefined,
      skills: ((parsed.tags as Record<string, unknown>)?.skills as string[]) ?? [],
      agentType: ((parsed.tags as Record<string, unknown>)?.agent_type as string) ?? undefined,
    }
  } catch {
    return null
  }
}

interface ChatTask {
  id: string
  chat_id: string
  messages: Array<{ role: string; content: string }>
  is_first_chat: boolean
  amount_usdc: string
}

/**
 * Bridge-side polling loop that uses MCP Sampling to get the host LLM
 * to generate responses. No external LLM API key needed.
 */
async function samplingPollingLoop(
  platformClient: Client,
  localServer: Server,
  systemPrompt: string,
): Promise<void> {
  console.error('[bridge] Auto-polling started (sampling mode)')

  while (true) {
    try {
      const result = await platformClient.callTool({
        name: 'get_next_task',
        arguments: { wait: 30 },
      })
      const parsed = parseToolResult(result) as { task: ChatTask | null } | null

      if (!parsed?.task) continue

      const task = parsed.task
      const lastMsg = task.messages.at(-1)?.content ?? ''
      const preview = lastMsg.length > 60 ? lastMsg.slice(0, 60) + '…' : lastMsg
      const label = task.is_first_chat ? ' (first chat)' : ''
      console.error(`\n[bridge] 💬 Task ${task.id}${label}`)
      console.error(`[bridge]   user: ${preview}`)

      try {
        const samplingMessages = task.messages.map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: { type: 'text' as const, text: m.content },
        }))

        const samplingResult = await localServer.createMessage({
          messages: samplingMessages,
          systemPrompt,
          maxTokens: 4096,
        })

        let replyText = ''
        if (typeof samplingResult.content === 'string') {
          replyText = samplingResult.content
        } else if (Array.isArray(samplingResult.content)) {
          replyText = samplingResult.content
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { type: string; text?: string }) => b.text ?? '')
            .join('\n')
        } else if (samplingResult.content?.type === 'text') {
          replyText = (samplingResult.content as { type: string; text: string }).text
        }

        if (!replyText.trim()) {
          console.error('[bridge]   ⚠ LLM returned empty response, skipping')
          continue
        }

        await platformClient.callTool({
          name: 'submit_response',
          arguments: { task_id: task.id, text: replyText },
        })

        const replyPreview = replyText.length > 60 ? replyText.slice(0, 60) + '…' : replyText
        console.error(`[bridge]   ✓ replied: ${replyPreview}`)
      } catch (e) {
        console.error(
          '[bridge]   ✗ sampling/submit error:',
          e instanceof Error ? e.message : e,
        )
      }
    } catch (e) {
      console.error(
        '[bridge] poll error, retry in 5s:',
        e instanceof Error ? e.message : e,
      )
      await sleep(5_000)
    }
  }
}

export async function startBridge(apiKey: string | null, baseUrl: string) {
  const { client: platformClient, transport: platformTransport } = buildPlatformClient(apiKey, baseUrl)
  await platformClient.connect(platformTransport)
  console.error('[agentjob] Connected to platform MCP endpoint')

  const { tools: platformTools } = await platformClient.listTools()
  console.error(`[agentjob] Discovered ${platformTools.length} tools from platform`)

  const { resources = [] } = await platformClient.listResources().catch(() => ({ resources: [] }))
  if (resources.length > 0) {
    console.error(`[agentjob] Discovered ${resources.length} resource(s): ${resources.map(r => r.uri).join(', ')}`)
  }

  const localServer = new Server(
    { name: 'agentjob', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        ...(resources.length > 0 ? { resources: {} } : {}),
      },
    }
  )

  let samplingActive = false

  localServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: platformTools,
  }))

  localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (samplingActive && request.params.name === 'get_next_task') {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            info: 'The bridge is handling chat polling automatically using your AI capabilities via MCP Sampling. You do NOT need to call get_next_task. The bridge handles incoming chat messages.',
          }),
        }],
      }
    }

    // Smart polling: bridge retries internally so the LLM only sees real tasks.
    // Each LLM call blocks for up to ~10 minutes. With ~5 tasks/day, context
    // grows by only ~50 entries/day instead of ~2800.
    if (request.params.name === 'get_next_task') {
      const maxWaitMs = 10 * 60 * 1_000
      const deadline = Date.now() + maxWaitMs
      while (Date.now() < deadline) {
        try {
          const result = await platformClient.callTool({
            name: 'get_next_task',
            arguments: { wait: 30 },
          })
          const parsed = parseToolResult(result) as { task: unknown } | null
          if (parsed?.task) return result
        } catch (e) {
          console.error('[bridge] get_next_task error, retry in 5s:', e instanceof Error ? e.message : e)
          await sleep(5_000)
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: '{"task":null}',
        }],
      }
    }

    try {
      return await platformClient.callTool({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      })
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
      }
    }
  })

  if (resources.length > 0) {
    const { ListResourcesRequestSchema, ReadResourceRequestSchema } =
      await import('@modelcontextprotocol/sdk/types.js')
    localServer.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }))
    localServer.setRequestHandler(ReadResourceRequestSchema, async (req) =>
      platformClient.readResource({ uri: req.params.uri })
    )
  }

  const stopHeartbeat = apiKey ? startHeartbeat(platformClient) : () => {}

  const stdioTransport = new StdioServerTransport()
  await localServer.connect(stdioTransport)

  if (apiKey) {
    // Check if the host LLM supports sampling
    const clientCaps = localServer.getClientCapabilities()
    const hasSampling = !!clientCaps?.sampling

    if (hasSampling) {
      samplingActive = true
      console.error('[agentjob] ✓ Connected — Sampling mode (fully autonomous)')
      console.error('[agentjob]   The bridge handles polling + replies automatically using your AI.')
      console.error('[agentjob]   No need to call get_next_task — the bridge handles incoming chat messages.')

      const profile = await fetchAgentProfile(platformClient)
      if (profile) {
        console.error(`[agentjob]   Agent: ${profile.name}`)
      }

      const systemPrompt = buildSamplingSystemPrompt(profile)
      samplingPollingLoop(platformClient, localServer, systemPrompt).catch((e) => {
        console.error('[agentjob] Sampling polling loop crashed:', e)
      })
    } else {
      console.error('[agentjob] ✓ Connected to AgentJob — Smart Polling mode')
      console.error('[agentjob]   Sampling: NOT supported by this client')
      console.error('[agentjob]   Smart Polling: ON — bridge waits internally, you only see real tasks')
      console.error('[agentjob]   Just call get_next_task in a loop. Each call blocks ~10 min inside the bridge.')
      console.error('[agentjob]   When a task arrives you get it instantly. Read task.messages and reply with submit_response.')
    }
  } else {
    console.error('[agentjob] Bridge ready in unauthenticated mode (read-only public tools)')
  }

  const shutdown = async () => {
    stopHeartbeat()
    await platformClient.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
