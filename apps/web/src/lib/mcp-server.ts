import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { publishChunk } from './stream-bus'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './db'
import {
  agentProfiles, agentChatTasks, agentSkillTags, agentFrameworkTags, agentRuntimeTags,
  skillTags, frameworkTags, runtimeTags, modelTags, agentTypeTags,
  chats, messages as messagesTable,
  users, agentDailyStats,
} from '@agentjob/db'
import { eq, and, asc, desc, inArray, count, sql } from 'drizzle-orm'
import { FREE_SLOT_WARNING_RATIO } from '@agentjob/shared'
import { isAgentOnlineByHeartbeat } from './agent-auth'
import { getPlatformConfig } from './platform-config'
import { hasSensitiveWords, generateRandomAgentName, generateApiKey, hashApiKey } from './utils'
import {
  cacheGetJson,
  rateLimitIdHash,
  redisLimiters,
  idempotencyStringGet,
  idempotencyStringSet,
} from './rate-limit'

const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MINUTES ?? '30') * 60 * 1_000
const MAX_WAIT_SECS   = 60

/** Daily quotas use UTC midnight (consistent across regions). */
function startOfTodayUTC(): Date {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

type AuthAgent = { id: string; name: string } | null

const LIST_AGENTS_CACHE_SEC = 60
const LIST_POSTS_CACHE_SEC = 60

let _agentInstructions: string | null = null
function getAgentInstructions(): string {
  if (!_agentInstructions) {
    try {
      _agentInstructions = readFileSync(
        join(process.cwd(), 'public', 'skill.md'),
        'utf-8',
      )
    } catch {
      _agentInstructions = 'Agent instructions not available. Call get_my_profile, then loop on get_next_task and submit_response.'
    }
  }
  return _agentInstructions
}

export async function createMcpServer(agent: AuthAgent) {
  const server = new McpServer({ name: 'agentjob', version: '1.0.0' })

  // ── Registration tools (public, no API key required) ──────────────────────

  server.registerTool(
    'register_send_otp',
    {
      description:
        'Step 1 of agent self-registration. Send a 6-digit OTP to the given email address via Coinbase CDP. ' +
        'Returns a flowId that must be passed to register_complete together with the OTP the user receives. ' +
        'Use this when a user wants to join AgentJob as an agent without going through the website.',
      inputSchema: z.object({
        email: z.string().email().describe('The email address to send the OTP to'),
      }),
    },
    async ({ email }) => {
      try {
        if (redisLimiters) {
          const { success } = await redisLimiters.otpEmailLimit.limit(rateLimitIdHash(email))
          if (!success) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: 'Too many OTP requests for this email. Please wait before trying again.' }],
            }
          }
        }
        const cdpResp = await fetch('https://api.cdp.coinbase.com/platform/v2/auth/email/otp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CDP-Project-Id': process.env.CDP_PROJECT_ID!,
          },
          body: JSON.stringify({ email }),
        })

        if (!cdpResp.ok) {
          return { isError: true, content: [{ type: 'text' as const, text: 'Failed to send OTP. Please try again.' }] }
        }

        const { flow_id: flowId } = await cdpResp.json()

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              flowId,
              message: `OTP sent to ${email}. Ask the user to check their inbox and provide the 6-digit code, then call register_complete.`,
            }),
          }],
        }
      } catch {
        return { isError: true, content: [{ type: 'text' as const, text: 'Internal error sending OTP.' }] }
      }
    }
  )

  server.registerTool(
    'register_complete',
    {
      description:
        'Step 2 of agent self-registration. Verify the OTP, create a user account and an agent profile, ' +
        'and return the API key. The API key is shown only once — instruct the user to save it. ' +
        'If the account already exists the key is not returned; user must reset it from the Dashboard.',
      inputSchema: z.object({
        email: z.string().email().describe('Same email used in register_send_otp'),
        flowId: z.string().min(1).describe('The flowId returned by register_send_otp'),
        otp: z.string().length(6).describe('6-digit code from the email'),
        agentName: z.string().min(1).max(100).optional().describe('Optional agent display name; auto-generated if omitted'),
      }),
    },
    async ({ email, flowId, otp, agentName }) => {
      // Verify OTP with CDP
      let walletAddress: string | null = null
      try {
        const cdpResp = await fetch('https://api.cdp.coinbase.com/platform/v2/auth/email/verify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CDP-Project-Id': process.env.CDP_PROJECT_ID!,
          },
          body: JSON.stringify({ flow_id: flowId, otp }),
        })

        if (!cdpResp.ok) {
          return { isError: true, content: [{ type: 'text' as const, text: 'Invalid OTP or expired. Ask the user to request a new code.' }] }
        }

        const json = await cdpResp.json()
        walletAddress = json.wallet_address ?? null
      } catch {
        return { isError: true, content: [{ type: 'text' as const, text: 'Failed to verify OTP.' }] }
      }

      // Upsert user
      const db = getDb()
      let user = await db.query.users.findFirst({ where: eq(users.email, email) })

      if (!user) {
        const [newUser] = await db
          .insert(users)
          .values({ email, wallet: walletAddress, emailVerifiedAt: new Date() })
          .returning()
        user = newUser
      } else {
        if (user.bannedAt) {
          return { isError: true, content: [{ type: 'text' as const, text: 'Account is banned.' }] }
        }
        if (!user.emailVerifiedAt) {
          await db.update(users)
            .set({ emailVerifiedAt: new Date(), wallet: walletAddress ?? user.wallet })
            .where(eq(users.id, user.id))
        }
      }

      // Auto-create agent
      const existing = await db.query.agentProfiles.findFirst({
        where: eq(agentProfiles.userId, user.id),
      })

      let apiKey: string | null = null
      let agentId: string

      if (existing) {
        agentId = existing.id
      } else {
        apiKey = generateApiKey()
        const [created] = await db
          .insert(agentProfiles)
          .values({
            userId: user.id,
            name: agentName ?? generateRandomAgentName(),
            priceSubsequent: '0.01',
            priceFirstMsg: '0.01',
            freeDailyMax: 5,
            apiKeyHash: hashApiKey(apiKey),
            customSkillTags: [],
          })
          .returning({ id: agentProfiles.id })
        agentId = created.id
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            agentId,
            walletAddress: walletAddress ?? user.wallet,
            apiKey,
            alreadyRegistered: existing != null,
            message: existing
              ? 'Agent already registered. Use https://agent-job.ai/dashboard to manage your API key.'
              : `Registration complete! Your API key is: ${apiKey}\n\nSave it now — it will not be shown again.\nNext step: set AGENTJOB_API_KEY=${apiKey} in your environment and run npx agentjob.`,
          }, null, 2),
        }],
      }
    }
  )

  // Public tools (no API key)

  server.registerTool(
    'list_agents',
    {
      description: 'Browse the AgentJob marketplace. Returns agents with online status, pricing, skills. Cached 60s.',
      inputSchema: z.object({
        online: z.boolean().optional().describe('If true, only online agents'),
      }),
    },
    async ({ online }) => {
      const rows = await cacheGetJson(
        'cache:mcp',
        'list_agents:v1',
        LIST_AGENTS_CACHE_SEC,
        async () => {
          const db = getDb()
          return db.query.agentProfiles.findMany({
            where: eq(agentProfiles.isActive, true),
            columns: {
              id: true, name: true, description: true,
              priceFirstMsg: true, priceSubsequent: true,
              customSkillTags: true, lastHeartbeatAt: true,
              totalChats: true, successRate: true,
            },
            orderBy: [desc(agentProfiles.totalChats)],
            limit: 50,
          })
        },
      )
      const result = (rows as { lastHeartbeatAt?: Date | string | null }[])
        .map((r) => ({
          ...r,
          online: isAgentOnlineByHeartbeat(
            r.lastHeartbeatAt instanceof Date ? r.lastHeartbeatAt : (r.lastHeartbeatAt ? new Date(r.lastHeartbeatAt) : null),
          ),
        }))
        .filter((r) => (online === true ? r.online : true))
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.registerTool(
    'get_agent',
    {
      description: 'Get one agent by UUID or 0x wallet address.',
      inputSchema: z.object({
        id: z.string().describe('Agent UUID or 0x wallet'),
      }),
    },
    async ({ id }) => {
      const db = getDb()
      const row = await db.query.agentProfiles.findFirst({
        where: and(eq(agentProfiles.id, id), eq(agentProfiles.isActive, true)),
      })
      if (!row) throw new Error('Agent not found')
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...row, online: isAgentOnlineByHeartbeat(row.lastHeartbeatAt) }, null, 2),
        }],
      }
    }
  )





  // Authenticated tools (Bearer API key)

  if (!agent) return server

  // ── MCP Resource: agent behavioral instructions ───────────────────────────
  server.registerResource(
    'agent-instructions',
    'agentjob://instructions',
    {
      description:
        'Behavioral instructions for AI agents. Read this after connecting to learn ' +
        'how to operate: heartbeat, polling for chat tasks, replying to customers.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: getAgentInstructions(),
      }],
    }),
  )

  server.registerTool(
    'heartbeat',
    {
      description: 'Refresh online status. The agentjob MCP bridge heartbeats every ~45s automatically. After heartbeat, start calling get_next_task in a loop to receive paid chat messages.',
      inputSchema: z.object({}),
    },
    async () => {
      const db = getDb()
      await db
        .update(agentProfiles)
        .set({ lastHeartbeatAt: new Date(), onlineStatus: 'online', updatedAt: new Date() })
        .where(eq(agentProfiles.id, agent.id))
      return { content: [{ type: 'text' as const, text: JSON.stringify({ next_heartbeat_in_seconds: 45, action_required: 'Start calling get_next_task in a loop to receive paid chat messages.' }) }] }
    }
  )

  server.registerTool(
    'get_next_task',
    {
      description: [
        'Call this in a loop to receive paid chat messages.',
        'The npx agentjob bridge handles retries internally — each call may block several minutes but you will only see real tasks.',
        'On { task: null }: call get_next_task again immediately.',
        'On task: read task.messages, generate a thoughtful reply, call submit_response(task_id, reply).',
        'Pattern: loop { task = get_next_task(); if (task) submit_response(task.id, your_reply) }',
      ].join(' '),
      inputSchema: z.object({
        wait: z.number().int().min(5).max(MAX_WAIT_SECS).default(30).optional()
          .describe('Max wait seconds (5–60, default 30). No wait=0 to avoid hot loops.'),
      }),
    },
    async ({ wait = 30 }) => {
      const db = getDb()
      await db
        .update(agentProfiles)
        .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(agentProfiles.id, agent.id))

      const deadline = Date.now() + wait * 1_000
      while (Date.now() < deadline) {
        const task = await db.query.agentChatTasks.findFirst({
          where: and(
            eq(agentChatTasks.agentId, agent.id),
            eq(agentChatTasks.status, 'pending')
          ),
          orderBy: [asc(agentChatTasks.createdAt)],
        })

        if (task) {
          const now = new Date()
          const [claimed] = await db
            .update(agentChatTasks)
            .set({ status: 'claimed', claimedAt: now, timeoutAt: task.verificationRunId ? task.timeoutAt : new Date(now.getTime() + TASK_TIMEOUT_MS) })
            .where(and(eq(agentChatTasks.id, task.id), eq(agentChatTasks.status, 'pending')))
            .returning({ id: agentChatTasks.id })

          if (!claimed) {
            await new Promise((r) => setTimeout(r, 100))
            continue
          }

          const profile = await db.query.agentProfiles.findFirst({
            where: eq(agentProfiles.id, task.agentId),
            columns: { name: true, description: true, customSkillTags: true },
          })
          const systemTagRows = await db.query.agentSkillTags.findMany({
            where: eq(agentSkillTags.agentProfileId, task.agentId),
            columns: { skillTagId: true },
          })
          const systemTagNames: string[] = []
          if (systemTagRows.length > 0) {
            const tagIds = systemTagRows.map((r) => r.skillTagId)
            const tags = await db.query.skillTags.findMany({
              where: inArray(skillTags.id, tagIds),
              columns: { name: true },
            })
            systemTagNames.push(...tags.map((t) => t.name))
          }
          const allSkillTags = [
            ...new Set([...systemTagNames, ...((profile?.customSkillTags ?? []) as string[])]),
          ]

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                task: {
                  id: task.id,
                  chat_id: task.chatId,
                  messages: task.messages,
                  user_id: task.userId,
                  is_first_chat: task.isFirstChat,
                  amount_usdc: task.amountUsdc,
                  agent_name: profile?.name ?? agent.name,
                  agent_description: profile?.description ?? null,
                  agent_skill_tags: allSkillTags,
                },
              }, null, 2),
            }],
          }
        }

        await new Promise((r) => setTimeout(r, 1_000))
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ task: null }) }] }
    }
  )

  server.registerTool(
    'submit_response',
    {
      description: 'Submit the assistant reply for a task. Must be called within the SLA window (default 30 min) after get_next_task returned the task.',
      inputSchema: z.object({
        task_id: z.string().uuid().describe('task.id from get_next_task'),
        text:    z.string().min(1).max(100_000).describe('Reply text (Markdown ok)'),
        idempotency_key: z.string().min(8).max(128).optional()
          .describe('Optional. Retries with the same key return the first successful response (24h).'),
      }),
    },
    async ({ task_id, text, idempotency_key }) => {
      if (idempotency_key) {
        const cached = await idempotencyStringGet(`mcp:submit:${agent.id}:${task_id}:${idempotency_key}`)
        if (cached) {
          return { content: [{ type: 'text' as const, text: cached }] }
        }
      }

      const db = getDb()
      const task = await db.query.agentChatTasks.findFirst({
        where: and(eq(agentChatTasks.id, task_id), eq(agentChatTasks.agentId, agent.id)),
      })
      if (!task) throw new Error('Task not found')
      if (task.status === 'completed' || task.status === 'failed')
        throw new Error(`Task already ${task.status}`)

      const now     = new Date()
      const today   = now.toISOString().slice(0, 10)

      if (task.verificationRunId) {
        const [saved] = await db.update(agentChatTasks)
          .set({ status: 'completed', responseText: text, completedAt: now })
          .where(and(eq(agentChatTasks.id, task_id), eq(agentChatTasks.status, 'claimed'),
            sql`${agentChatTasks.timeoutAt} > now()`, sql`${agentChatTasks.cancelRequestedAt} IS NULL`))
          .returning({ id: agentChatTasks.id })
        if (!saved) throw new Error('Request no longer accepting replies')
        return { content: [{ type: 'text' as const, text: JSON.stringify({ submitted: true }) }] }
      }

      const [completed] = await db.update(agentChatTasks)
        .set({ status: 'completed', responseText: text, completedAt: now })
        .where(and(eq(agentChatTasks.id, task_id), inArray(agentChatTasks.status, ['pending', 'claimed'])))
        .returning({ id: agentChatTasks.id })
      if (!completed) throw new Error('Request already completed, cancelled or failed')

      await db.update(chats).set({ status: 'completed' }).where(eq(chats.id, task.chatId)).catch(() => {})
      await db.insert(messagesTable)
        .values({ chatId: task.chatId, role: 'assistant', content: text })
        .catch(() => {})

      // Publish done event for SSE streaming
      publishChunk(task.chatId, { type: 'done', text })

      const p = await db.query.agentProfiles.findFirst({ where: eq(agentProfiles.id, agent.id) })
      if (p) {
        const total = (p.totalChats ?? 0) + 1
        const successRate = total > 0 ? (total - (p.noResponseCount ?? 0)) / total : 1

        // Check remaining pending tasks to decide online vs busy
        const [{ value: remaining }] = await db
          .select({ value: count() })
          .from(agentChatTasks)
          .where(and(eq(agentChatTasks.agentId, agent.id), eq(agentChatTasks.status, 'pending')))
        const maxChats = p.maxConcurrentChats ?? 2
        const newStatus = Number(remaining) >= maxChats ? 'busy' as const : 'online' as const

        await db.update(agentProfiles)
          .set({
            totalChats: total,
            successRate: String(successRate.toFixed(4)),
            activeChatId: null,
            onlineStatus: newStatus,
            lastMessageAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
          })
          .where(eq(agentProfiles.id, agent.id))
      }

      // Update daily reply count and check capacity warning
      const [updatedStats] = await db
        .insert(agentDailyStats)
        .values({ agentId: agent.id, statDate: today, freeUsersCount: 0, totalReplies: 1 })
        .onConflictDoUpdate({
          target: [agentDailyStats.agentId, agentDailyStats.statDate],
          set: { totalReplies: sql`${agentDailyStats.totalReplies} + 1` },
        })
        .returning()

      const dailyLimit = p?.dailyReplyLimit ?? 0
      const totalReplies = updatedStats?.totalReplies ?? 1

      if (dailyLimit > 0 && totalReplies > dailyLimit) {
        console.warn(`[mcp submit_response] Agent ${agent.id} exceeded daily reply limit ${dailyLimit}`)
      }

      let replyHint: string | undefined
      if (dailyLimit > 0) {
        const remaining = dailyLimit - totalReplies
        const ratio = remaining / dailyLimit
        if (ratio <= FREE_SLOT_WARNING_RATIO) {
          replyHint = "You're reaching your daily limit"
        }
      }

      const result: Record<string, unknown> = { submitted: true }
      if (replyHint) result.reply_hint = replyHint

      const outText = JSON.stringify(result)
      if (idempotency_key) {
        await idempotencyStringSet(`mcp:submit:${agent.id}:${task_id}:${idempotency_key}`, outText)
      }

      return { content: [{ type: 'text' as const, text: outText }] }
    }
  )

  server.registerTool(
    'submit_stream_chunk',
    {
      description: 'Send a streaming text chunk for a chat task (typewriter effect). Call this multiple times with deltas, then submit_response for the final text.',
      inputSchema: z.object({
        task_id: z.string().uuid().describe('task.id from get_next_task'),
        delta: z.string().describe('Incremental text chunk to display'),
      }),
    },
    async ({ task_id, delta }) => {
      const db = getDb()
      const task = await db.query.agentChatTasks.findFirst({
        where: and(eq(agentChatTasks.id, task_id), eq(agentChatTasks.agentId, agent.id)),
        columns: { chatId: true, status: true },
      })
      if (!task) throw new Error('Task not found')
      if (task.status === 'completed' || task.status === 'failed') {
        throw new Error(`Task already ${task.status}`)
      }
      publishChunk(task.chatId, { type: 'delta', text: delta })
      return { content: [{ type: 'text' as const, text: '{"ok":true}' }] }
    }
  )

  server.registerTool(
    'get_my_profile',
    {
      description: 'Current agent profile: name, wallet, USDC balance, pricing, tags, online status, stats.',
      inputSchema: z.object({}),
    },
    async () => {
      const db = getDb()
      const profile = await db.query.agentProfiles.findFirst({
        where: eq(agentProfiles.id, agent.id),
      })
      if (!profile) throw new Error('Agent profile not found')

      const ownerUser = await db.query.users.findFirst({
        where: eq(users.id, profile.userId),
        columns: { email: true, wallet: true },
      })

      const [skillRows, frameworkRows, runtimeRows, modelRow, agentTypeRow] = await Promise.all([
        db.select({ name: skillTags.name })
          .from(agentSkillTags)
          .innerJoin(skillTags, eq(agentSkillTags.skillTagId, skillTags.id))
          .where(eq(agentSkillTags.agentProfileId, profile.id)),
        db.select({ name: frameworkTags.name })
          .from(agentFrameworkTags)
          .innerJoin(frameworkTags, eq(agentFrameworkTags.frameworkTagId, frameworkTags.id))
          .where(eq(agentFrameworkTags.agentProfileId, profile.id)),
        db.select({ name: runtimeTags.name })
          .from(agentRuntimeTags)
          .innerJoin(runtimeTags, eq(agentRuntimeTags.runtimeTagId, runtimeTags.id))
          .where(eq(agentRuntimeTags.agentProfileId, profile.id)),
        profile.modelTagId
          ? db.select({ name: modelTags.name }).from(modelTags)
              .where(eq(modelTags.id, profile.modelTagId)).then(r => r[0]?.name ?? null)
          : Promise.resolve(null),
        profile.agentTypeTagId
          ? db.select({ name: agentTypeTags.name }).from(agentTypeTags)
              .where(eq(agentTypeTags.id, profile.agentTypeTagId)).then(r => r[0]?.name ?? null)
          : Promise.resolve(null),
      ])

      const isOnline = isAgentOnlineByHeartbeat(profile.lastHeartbeatAt)
      const isWalletRegistered = ownerUser?.email?.endsWith('@wallet.agentjob.ai') ?? false

      let walletBalance: { usdc: string; usdc_raw: string } | null = null
      const walletAddress = ownerUser?.wallet
      if (walletAddress) {
        try {
          const selector = '70a08231'
          const paddedAddr = walletAddress.slice(2).toLowerCase().padStart(64, '0')
          const calldata = `0x${selector}${paddedAddr}`
          const rpcResp = await fetch('https://mainnet.base.org', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'eth_call',
              params: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: calldata }, 'latest'],
            }),
          })
          const { result } = await rpcResp.json() as { result?: string }
          if (result && result !== '0x') {
            const raw = BigInt(result)
            walletBalance = { usdc: (Number(raw) / 1_000_000).toFixed(2), usdc_raw: raw.toString() }
          } else {
            walletBalance = { usdc: '0.00', usdc_raw: '0' }
          }
        } catch { /* non-fatal */ }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            agent_id: profile.id,
            name: profile.name,
            bio: profile.bio,
            wallet_address: walletAddress ?? null,
            wallet_balance: walletBalance,
            email: isWalletRegistered ? null : ownerUser?.email ?? null,
            registration_type: isWalletRegistered ? 'wallet (api)' : 'email (web)',
            pricing: {
              per_message_usdc: Number(profile.priceSubsequent),
              free_daily_slots: profile.freeDailyMax,
              free_messages_per_user: profile.freeMessagesPerUser,
              daily_reply_limit: profile.dailyReplyLimit,
            },
            max_concurrent_chats: profile.maxConcurrentChats,
            tags: {
              agent_type: agentTypeRow,
              model: modelRow,
              skills: skillRows.map(r => r.name),
              frameworks: frameworkRows.map(r => r.name),
              runtimes: runtimeRows.map(r => r.name),
            },
            status: {
              online: isOnline,
              online_status: profile.onlineStatus,
              last_heartbeat: profile.lastHeartbeatAt,
            },
            stats: {
              total_hired: profile.totalHired,
              total_chats: profile.totalChats,
              success_rate: Number(profile.successRate),
              total_revenue_usdc: Number(profile.totalRevenue),
            },
            is_active: profile.isActive,
            created_at: profile.createdAt,
          }, null, 2),
        }],
      }
    }
  )

  server.registerTool(
    'update_agent_profile',
    {
      description:
        'Update your agent profile. All fields are optional — only provided fields are changed. ' +
        'Use this to set display name, bio, pricing, daily limits, tags, and concurrency. ' +
        'Tags are set by name (case-insensitive); call list_tags to see available options. ' +
        'Server Wallet agents must use this tool since they cannot access the web Dashboard.',
      inputSchema: z.object({
        name: z.string().min(1).max(100).optional().describe('Display name (1–100 chars)'),
        bio: z.string().max(70).optional().describe('Short Agent bio (max 70 chars)'),
        description: z.string().max(2000).optional().describe('Longer profile description (max 2000 chars)'),
        priceSubsequent: z.string().regex(/^\d+(\.\d+)?$/).optional()
          .describe('Per-message price in USDC (e.g. "0.05")'),
        freeDailyMax: z.number().int().min(0).max(100).optional()
          .describe('Max free messages per day across all users (0-100, 0 = disable free)'),
        freeMessagesPerUser: z.number().int().min(1).max(100).optional()
          .describe('Lifetime free messages per user across all chats (1-100, default 1)'),
        dailyReplyLimit: z.number().int().min(0).optional()
          .describe('Daily reply cap (0 = unlimited)'),
        maxConcurrentChats: z.number().int().min(1).max(5).optional()
          .describe('Max simultaneous chats (1–5, default 2)'),
        agentType: z.string().max(50).optional()
          .describe('Agent type name (e.g. "Coding Assistant"). Call list_tags to see options.'),
        model: z.string().max(50).optional()
          .describe('Model name (e.g. "GPT-4o"). Call list_tags to see options.'),
        skills: z.array(z.string().max(50)).max(5).optional()
          .describe('Skill names, up to 5 (e.g. ["Python", "JavaScript"]). Call list_tags to see options.'),
        frameworks: z.array(z.string().max(50)).max(2).optional()
          .describe('Framework names, up to 2 (e.g. ["LangChain"]). Call list_tags to see options.'),
        runtimes: z.array(z.string().max(50)).max(2).optional()
          .describe('Runtime names, up to 2 (e.g. ["Docker"]). Call list_tags to see options.'),
      }),
    },
    async (params) => {
      const db = getDb()
      const updates: Record<string, unknown> = { updatedAt: new Date() }

      if (params.name !== undefined) {
        if (hasSensitiveWords(params.name)) throw new Error('Name contains prohibited words')
        updates.name = params.name
      }
      if (params.bio !== undefined) {
        if (hasSensitiveWords(params.bio)) throw new Error('Bio contains prohibited words')
        updates.bio = params.bio
      }
      if (params.description !== undefined) {
        if (hasSensitiveWords(params.description)) throw new Error('Description contains prohibited words')
        updates.description = params.description
      }
      if (params.priceSubsequent !== undefined) updates.priceSubsequent = params.priceSubsequent
      if (params.freeDailyMax !== undefined) {
        const config = await getPlatformConfig()
        if (params.freeDailyMax > config.agentFreeMessagesPerUserMax) throw new Error(`Daily free slots cannot exceed the platform maximum of ${config.agentFreeMessagesPerUserMax}`)
        updates.freeDailyMax = params.freeDailyMax
      }
      if (params.freeMessagesPerUser !== undefined) {
        const config = await getPlatformConfig()
        if (params.freeMessagesPerUser > config.agentFreeMessagesPerUserMax) throw new Error(`Free messages per user cannot exceed the platform maximum of ${config.agentFreeMessagesPerUserMax}`)
        updates.freeMessagesPerUser = params.freeMessagesPerUser
      }
      if (params.dailyReplyLimit !== undefined) updates.dailyReplyLimit = params.dailyReplyLimit
      if (params.maxConcurrentChats !== undefined) {
        updates.maxConcurrentChats = params.maxConcurrentChats
        updates.exclusiveMode = params.maxConcurrentChats === 1
      }

      // Resolve agent type by name
      if (params.agentType !== undefined) {
        const row = await db.select({ id: agentTypeTags.id }).from(agentTypeTags)
          .where(sql`lower(${agentTypeTags.name}) = lower(${params.agentType})`)
          .limit(1)
        if (row.length === 0) throw new Error(`Unknown agent type "${params.agentType}". Call list_tags to see options.`)
        updates.agentTypeTagId = row[0].id
      }

      // Resolve model by name
      if (params.model !== undefined) {
        const row = await db.select({ id: modelTags.id }).from(modelTags)
          .where(sql`lower(${modelTags.name}) = lower(${params.model})`)
          .limit(1)
        if (row.length === 0) throw new Error(`Unknown model "${params.model}". Call list_tags to see options.`)
        updates.modelTagId = row[0].id
      }

      await db.update(agentProfiles).set(updates).where(eq(agentProfiles.id, agent.id))

      // Update skill tags (M:N)
      if (params.skills !== undefined) {
        const resolvedSkills = await Promise.all(
          params.skills.map(async (name) => {
            const [row] = await db.select({ id: skillTags.id }).from(skillTags)
              .where(sql`lower(${skillTags.name}) = lower(${name})`)
              .limit(1)
            if (!row) throw new Error(`Unknown skill "${name}". Call list_tags to see options.`)
            return row.id
          })
        )
        await db.delete(agentSkillTags).where(eq(agentSkillTags.agentProfileId, agent.id))
        if (resolvedSkills.length > 0) {
          await db.insert(agentSkillTags)
            .values(resolvedSkills.map(id => ({ agentProfileId: agent.id, skillTagId: id })))
            .onConflictDoNothing()
        }
      }

      // Update framework tags (M:N)
      if (params.frameworks !== undefined) {
        const resolvedFrameworks = await Promise.all(
          params.frameworks.map(async (name) => {
            const [row] = await db.select({ id: frameworkTags.id }).from(frameworkTags)
              .where(sql`lower(${frameworkTags.name}) = lower(${name})`)
              .limit(1)
            if (!row) throw new Error(`Unknown framework "${name}". Call list_tags to see options.`)
            return row.id
          })
        )
        await db.delete(agentFrameworkTags).where(eq(agentFrameworkTags.agentProfileId, agent.id))
        if (resolvedFrameworks.length > 0) {
          await db.insert(agentFrameworkTags)
            .values(resolvedFrameworks.map(id => ({ agentProfileId: agent.id, frameworkTagId: id })))
            .onConflictDoNothing()
        }
      }

      // Update runtime tags (M:N)
      if (params.runtimes !== undefined) {
        const resolvedRuntimes = await Promise.all(
          params.runtimes.map(async (name) => {
            const [row] = await db.select({ id: runtimeTags.id }).from(runtimeTags)
              .where(sql`lower(${runtimeTags.name}) = lower(${name})`)
              .limit(1)
            if (!row) throw new Error(`Unknown runtime "${name}". Call list_tags to see options.`)
            return row.id
          })
        )
        await db.delete(agentRuntimeTags).where(eq(agentRuntimeTags.agentProfileId, agent.id))
        if (resolvedRuntimes.length > 0) {
          await db.insert(agentRuntimeTags)
            .values(resolvedRuntimes.map(id => ({ agentProfileId: agent.id, runtimeTagId: id })))
            .onConflictDoNothing()
        }
      }

      const updated = await db.query.agentProfiles.findFirst({
        where: eq(agentProfiles.id, agent.id),
        columns: {
          name: true, bio: true, description: true, priceSubsequent: true,
          freeDailyMax: true, freeMessagesPerUser: true, dailyReplyLimit: true, maxConcurrentChats: true,
        },
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, profile: updated }, null, 2) }] }
    }
  )

  server.registerTool(
    'list_tags',
    {
      description:
        'List all available tags grouped by type. Use the returned names when calling update_agent_profile ' +
        'to set your agent_type, model, skills, frameworks, and runtimes.',
      inputSchema: z.object({}),
    },
    async () => {
      const db = getDb()
      const [skills, models, frameworks, rtimes, agentTypes] = await Promise.all([
        db.select({ name: skillTags.name }).from(skillTags)
          .where(eq(skillTags.isActive, true)).orderBy(asc(skillTags.sortOrder)),
        db.select({ name: modelTags.name, provider: modelTags.provider }).from(modelTags)
          .where(eq(modelTags.isActive, true)).orderBy(asc(modelTags.sortOrder)),
        db.select({ name: frameworkTags.name }).from(frameworkTags)
          .where(eq(frameworkTags.isActive, true)).orderBy(asc(frameworkTags.sortOrder)),
        db.select({ name: runtimeTags.name }).from(runtimeTags)
          .where(eq(runtimeTags.isActive, true)).orderBy(asc(runtimeTags.sortOrder)),
        db.select({ name: agentTypeTags.name }).from(agentTypeTags)
          .where(eq(agentTypeTags.isActive, true)).orderBy(asc(agentTypeTags.sortOrder)),
      ])
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            agent_types: agentTypes.map(r => r.name),
            models: models.map(r => r.provider ? `${r.name} (${r.provider})` : r.name),
            skills: skills.map(r => r.name),
            frameworks: frameworks.map(r => r.name),
            runtimes: rtimes.map(r => r.name),
            usage_hint: 'Pass these names to update_agent_profile. For models, use the name part only (without provider).',
          }, null, 2),
        }],
      }
    }
  )

  server.registerTool(
    'withdraw_usdc',
    {
      description: 'Use POST /api/agents/me/withdrawals with an Idempotency-Key for USDC withdrawals. This legacy tool does not transfer funds.',
      inputSchema: z.object({ toAddress: z.string(), amount: z.string() }),
    },
    async () => ({ isError: true, content: [{ type: 'text' as const,
      text: 'Use POST https://agent-job.ai/api/agents/me/withdrawals with your Provider Key, a persistent Idempotency-Key, and {toAddress,amount}. Check the returned withdrawal ID via GET /api/agents/me/withdrawals/{id}. Base ETH is required in the registered server wallet.' }] }),
  )

  return server
}
