import { NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import {
  agentProfiles,
  chats,
  payments,
  users,
  messages as messagesTable,
  agentChatTasks,
} from '@agentjob/db'
import { eq, and, count } from 'drizzle-orm'
import { executeX402Payment, extractPaymentHeader } from '@/lib/x402'
import { getPlatformConfig } from '@/lib/platform-config'
import { isAgentOnlineByHeartbeat } from '@/lib/agent-auth'
import { chatEligibilityOwnershipStatus } from '@/lib/chat-eligibility'
import { idempotencyHttpGet, idempotencyHttpSet } from '@/lib/rate-limit'
import { acceptanceChat, getChatPaymentIntent } from '@/lib/acceptance-chat-route'
import { ChatPaymentAcceptanceError } from '@/lib/chat-payment-acceptance'
import { createFreeChatRequests, freeChatResponse, FreeChatRequestError } from '@/lib/free-chat-requests'

import { validateChatAttachments } from '@/lib/chat-attachments'

const freeRequests = createFreeChatRequests()

/** Dev mode: BYPASS_X402=true skips payment (non-production only) */
const BYPASS_X402 = process.env.BYPASS_X402 === 'true' && process.env.NODE_ENV !== 'production'

const USDC_BASE  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_EXTRA = { name: 'USD Coin', version: '2' } as const

function chatIdempotencyKey(req: NextRequest): string | null {
  const raw = req.headers.get('idempotency-key') ?? req.headers.get('Idempotency-Key')
  if (!raw) return null
  const t = raw.trim()
  if (!t || t.length > 128) return null
  return t
}

/**
 * POST /api/chat
 * Free messages are consumed atomically per user/Agent and per Agent/day;
 * otherwise charge priceSubsequent. Paid path keeps the two-phase x402 flow (platform_fee → agent).
 */
export async function POST(req: NextRequest) {
  try { return await handlePost(req) }
  catch (error) {
    if (error instanceof ChatPaymentAcceptanceError || error instanceof FreeChatRequestError) return jsonErr(error.code, error.status, error.code)
    console.error('[chat] request failed; retry with the same Idempotency-Key')
    return jsonErr('Request could not be completed. Retry the same message; do not start a new payment.', 503, 'chat_retry_required')
  }
}

async function handlePost(req: NextRequest) {
  const tag = `[chat ${new Date().toISOString()}]`

  const body = await req.json().catch(() => null)
  if (!body) return jsonErr('Invalid request body', 400, 'bad_request')

  const { messages, chat_id: existingChatId, payment_target } = body
  const payTarget: 'platform_fee' | 'agent' = payment_target === 'platform_fee' ? 'platform_fee' : 'agent'
  const agentIdHeader: string  = req.headers.get('x-agent-id') ?? body.agent_id ?? ''
  const agentWalletHeader: string = req.headers.get('x-agent-wallet') ?? ''

  console.log(`${tag} POST /api/chat — target=${payTarget} wallet=${agentWalletHeader || '(none)'} chatId=${existingChatId || 'new'} msgs=${messages?.length ?? 0}`)

  if (!agentIdHeader && !agentWalletHeader) return jsonErr('Missing agent_id or x-agent-wallet', 400, 'bad_request')
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return jsonErr('Missing messages', 400, 'bad_request')
  }
  if (messages.length > 200 || !messages.every(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string') || messages.at(-1).role !== 'user') return jsonErr('Invalid messages', 400, 'bad_request')
  if (existingChatId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existingChatId)) return jsonErr('Invalid chat ID', 400, 'bad_request')

  const session = await getSession()
  if (!session.userId) {
    console.log(`${tag} → 401 Unauthorized`)
    return jsonErr('Unauthorized', 401, 'unauthorized')
  }

  const idemKey = chatIdempotencyKey(req)
  if (!idemKey) return jsonErr('A stable Idempotency-Key is required. Retry the same message with the same key.', 400, 'idempotency_required')

  const db = getDb()
  let agent
  let agentWalletAddress: string | null = null

  if (agentWalletHeader) {
    const ownerUser = await db.query.users.findFirst({
      where: eq(users.wallet, agentWalletHeader),
    })
    if (!ownerUser) {
      console.log(`${tag} → 404 No user found for wallet ${agentWalletHeader}`)
      return jsonErr('No agent found for this wallet address', 404, 'agent_not_found')
    }
    agentWalletAddress = ownerUser.wallet ?? null
    agent = await db.query.agentProfiles.findFirst({
      where: eq(agentProfiles.userId, ownerUser.id),
    })
  } else {
    agent = await db.query.agentProfiles.findFirst({
      where: eq(agentProfiles.id, agentIdHeader),
    })
    if (agent) {
      const ownerUser = await db.query.users.findFirst({
        where: eq(users.id, agent.userId),
        columns: { wallet: true },
      })
      agentWalletAddress = ownerUser?.wallet ?? null
    }
  }
  const agentId = agent?.id ?? agentIdHeader

  if (!agent) {
    console.log(`${tag} → 404 Agent not found (id=${agentIdHeader})`)
    return jsonErr('Agent not found', 404, 'agent_not_found')
  }

  const freeInput = { userId: session.userId, agentId, idempotencyKey: idemKey, requestedChatId: existingChatId ?? null, messages }
  let previousRequest = await freeRequests.get(freeInput)
  if (previousRequest?.decision === 'free') return freeChatResponse(previousRequest)
  const previousPayment = !BYPASS_X402 ? await getChatPaymentIntent({ userId: session.userId, idempotencyKey: idemKey }) : null
  if (!previousRequest && !previousPayment) {
    previousRequest = await freeRequests.restoreLegacy(freeInput, () => idempotencyHttpGet(`chat:${session.userId}:${idemKey}:free`))
    if (previousRequest?.decision === 'free') return freeChatResponse(previousRequest)
  }
  const online = isAgentOnlineByHeartbeat(agent.lastHeartbeatAt)
  let chatId = existingChatId ?? previousRequest?.chatId ?? previousPayment?.chatId ?? crypto.randomUUID()
  const config = await getPlatformConfig()
  const ownedChat = await db.query.chats.findFirst({ where: eq(chats.id, chatId) })
  if (chatEligibilityOwnershipStatus(ownedChat, session.userId, agentId) === 404) return jsonErr('Chat not found', 404, 'chat_not_found')
  const acceptanceInput = { req, session, agentId, chatId, key: idemKey, messages, stage: payTarget, totalUsdc: agent.priceSubsequent, feeRate: config.platformFeeRate, agentWallet: agentWalletAddress, online }
  if (previousPayment) return acceptanceChat(acceptanceInput)
  const existingChat = ownedChat ?? null
  const isFirstChat = !existingChat
  try { await validateChatAttachments(messages, session.userId, agentId, existingChatId ?? '') }
  catch (error) { return jsonErr(error instanceof Error ? error.message : 'Attachment unavailable.', 400, 'attachment_unavailable') }

  const decision = previousRequest ?? await freeRequests.consume(freeInput)
  if (decision.decision === 'free') return freeChatResponse(decision)
  if (!agent.isActive) return jsonErr('Agent not found', 404, 'agent_not_found')
  if (!online) {
    const lastSeen = agent.lastHeartbeatAt
      ? `last heartbeat ${Math.round((Date.now() - new Date(agent.lastHeartbeatAt).getTime()) / 1000)}s ago`
      : 'never online'
    console.log(`${tag} → 503 agent_offline — ${lastSeen}`)
    return jsonErr(`Agent offline (${lastSeen}). Is your MCP bridge running?`, 503, 'agent_offline')
  }

  // Concurrent chat limit check
  const maxChats = agent.maxConcurrentChats ?? 2
  const [{ value: pendingCount }] = await db
    .select({ value: count() })
    .from(agentChatTasks)
    .where(and(eq(agentChatTasks.agentId, agentId), eq(agentChatTasks.status, 'pending')))
  if (Number(pendingCount) >= maxChats) {
    console.log(`${tag} → 503 agent_busy — pendingTasks=${pendingCount} max=${maxChats}`)
    return jsonErr(`Agent is busy (${pendingCount}/${maxChats} chats active). Try again later.`, 503, 'agent_busy')
  }

  chatId = decision.chatId
  acceptanceInput.chatId = chatId
  const isFreeMsg = false
  const freeSlotHint = decision.slotHint

  if (BYPASS_X402 && idemKey) {
    const scope = payTarget === 'platform_fee' ? 'pf' : 'agent'
    const cached = await idempotencyHttpGet(`chat:${session.userId}:${idemKey}:${scope}`)
    if (cached) {
      return new Response(cached.body, { status: cached.status, headers: new Headers(cached.headers) })
    }
  }

  // ── Paid path (non-free message) ────────────────────────────────────────────
  if (!isFreeMsg) {
    if (!BYPASS_X402) return acceptanceChat(acceptanceInput)
    // Migration acceptance starts with real Agent replies, without settling funds.
    if (!BYPASS_X402 && process.env.ENABLE_REAL_PAYMENTS !== 'true') {
      return jsonErr('Paid requests are temporarily unavailable', 503, 'payments_disabled')
    }
    const totalUsdc     = parseFloat(agent.priceSubsequent)
    const platformFeeUsdc = totalUsdc * config.platformFeeRate
    const agentUsdc     = totalUsdc * (1 - config.platformFeeRate)

    const platformWallet = process.env.PLATFORM_WALLET_ADDRESS ?? ''
    const isPlatformFee  = payTarget === 'platform_fee'
    if (isPlatformFee && platformFeeUsdc === 0) return Response.json({ ok: true, chat_id: chatId })
    const payToAddress   = isPlatformFee ? platformWallet : agentWalletAddress
    const payAmount      = isPlatformFee ? platformFeeUsdc : agentUsdc
    const payAmountMicro = String(Math.round(payAmount * 1_000_000))

    console.log(`${tag} paid path target=${payTarget} total=${totalUsdc} fee=${platformFeeUsdc} agent=${agentUsdc} payTo=${payToAddress} amount=${payAmount}`)

    if (!payToAddress) {
      const reason = isPlatformFee
        ? 'Platform wallet not configured (PLATFORM_WALLET_ADDRESS)'
        : 'Agent has no payout wallet configured'
      console.log(`${tag} → 503 no_wallet — ${reason}`)
      return jsonErr(reason, 503, 'no_wallet')
    }

    const paymentRequirements = {
      scheme: 'exact' as const,
      network: 'base' as const,
      maxAmountRequired: payAmountMicro,
      resource: req.url,
      description: isPlatformFee ? 'AgentJob platform fee' : 'AgentJob agent payment',
      mimeType: 'application/json',
      payTo: payToAddress,
      maxTimeoutSeconds: 300,
      asset: USDC_BASE,
      extra: USDC_EXTRA,
    }

    let txHash: string | undefined

    if (BYPASS_X402) {
      console.warn(`${tag} ⚠️  BYPASS_X402=true — skipping payment (dev only)`)
      txHash = 'dev_bypass'
    } else {
      const paymentHeader = extractPaymentHeader(req)
      if (!paymentHeader) {
        console.log(`${tag} → 402 ${payTarget} — amount=${payAmount} USDC payTo=${payToAddress}`)
        return new Response(
          JSON.stringify({ x402Version: 1, error: 'Payment required', accepts: [paymentRequirements] }),
          { status: 402, headers: { 'Content-Type': 'application/json' } }
        )
      }

      console.log(`${tag} x402 optimistic [${payTarget}] — amount=${payAmount} USDC payTo=${payToAddress}`)
      const paymentResult = await executeX402Payment({
        paymentHeader,
        agentWallet: payToAddress,
        amountUsdc: payAmount,
        platformFeeRate: 0,
        paymentRequirements,
      })

      if (!paymentResult.success) {
        const status = paymentResult.failedOn === 'verify' ? 402 : 500
        console.log(`${tag} → ${status} payment_failed [${payTarget}] on=${paymentResult.failedOn} err=${paymentResult.error}`)
        return jsonErr(`Payment failed (${paymentResult.failedOn}): ${paymentResult.error}`, status, 'payment_failed')
      }
      txHash = paymentResult.agentTx ?? (paymentResult.optimistic ? 'optimistic' : undefined)
      console.log(`${tag} OK [${payTarget}] payment ${paymentResult.optimistic ? '(optimistic, settle async)' : `tx=${txHash}`}`)
    }

    // Platform fee phase: return 200, client proceeds to agent phase
    if (isPlatformFee) {
      console.log(`${tag} → 200 platform_fee_paid`)
      const body = JSON.stringify({ ok: true, chat_id: chatId, tx: txHash })
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
      if (idemKey) {
        await idempotencyHttpSet(`chat:${session.userId}:${idemKey}:pf`, { status: 200, body, headers })
      }
      return new Response(body, { status: 200, headers: new Headers(headers) })
    }

    // Agent payment phase: write to database
    await writeChatAndTask({
      db, chatId, agentId, session, isFirstChat, existingChat,
      messages, totalUsdc, platformFeeUsdc, agentUsdc,
      txPlatform: BYPASS_X402 ? 'dev_bypass' : undefined,
      txAgent: txHash,
      agent,
    })

    console.log(`${tag} → 202 OK (paid) — chatId=${chatId}`)
    const paidBody = JSON.stringify({
      chat_id: chatId,
      status: 'pending',
      is_free: false,
      ...(freeSlotHint ? { slot_hint: freeSlotHint } : {}),
    })
    const paidHeaders: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Chat-Id': chatId,
    }
    if (idemKey) {
      await idempotencyHttpSet(`chat:${session.userId}:${idemKey}:agent`, {
        status: 202,
        body: paidBody,
        headers: paidHeaders,
      })
    }
    return new Response(paidBody, { status: 202, headers: new Headers(paidHeaders) })
  }

  return jsonErr('Request could not be completed.', 503, 'chat_retry_required')
}

interface WriteChatParams {
  db: ReturnType<typeof getDb>
  chatId: string
  agentId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any
  isFirstChat: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existingChat: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[]
  totalUsdc: number
  platformFeeUsdc: number
  agentUsdc: number
  txPlatform?: string
  txAgent?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any
  skipPaymentRecord?: boolean
}

async function writeChatAndTask({
  db, chatId, agentId, session, isFirstChat, existingChat,
  messages, totalUsdc, platformFeeUsdc, agentUsdc,
  txPlatform, txAgent, agent, skipPaymentRecord = false,
}: WriteChatParams) {
  // Insert or update chat record
  if (isFirstChat) {
    await db.insert(chats).values({
      id: chatId,
      userId: session.userId,
      agentId,
      isFirstChat: 0,
      totalMessages: 1,
      lastMessageAt: new Date(),
    })
  } else {
    await db
      .update(chats)
      .set({ totalMessages: (existingChat!.totalMessages ?? 0) + 1, lastMessageAt: new Date() })
      .where(eq(chats.id, chatId))
  }

  // Insert payment record (skipped for free messages)
  if (!skipPaymentRecord) {
    await db.insert(payments).values({
      chatId,
      payerId: session.userId,
      amountPlatform: String(platformFeeUsdc),
      amountAgent: String(agentUsdc),
      txPlatform,
      txAgent,
      status: 'success',
    })
  }

  // Set busy if at capacity after this task
  const maxChats = agent.maxConcurrentChats ?? 2
  const [{ value: afterCount }] = await db
    .select({ value: count() })
    .from(agentChatTasks)
    .where(and(eq(agentChatTasks.agentId, agentId), eq(agentChatTasks.status, 'pending')))
  if (Number(afterCount) >= maxChats) {
    await db.update(agentProfiles)
      .set({ onlineStatus: 'busy', lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(agentProfiles.id, agentId))
  }

  // Save last user message
  const lastUserMsg = messages[messages.length - 1]
  if (lastUserMsg?.role === 'user') {
    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : JSON.stringify(lastUserMsg.content)
    await db.insert(messagesTable).values({ chatId, role: 'user', content, attachments: messages.at(-1).attachments ?? [] }).catch(() => {})
  }

  // Enqueue agent_chat_tasks
  const [task] = await db
    .insert(agentChatTasks)
    .values({
      agentId,
      chatId,
      userId: session.userId,
      messages,
      isFirstChat,
      amountUsdc: String(totalUsdc),
      status: 'pending',
    })
    .returning({ id: agentChatTasks.id })

  return task
}

function jsonErr(message: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
