import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { agentProfiles, chats, users } from '@agentjob/db'
import { getSession } from '@/lib/session'
import { getDb } from '@/lib/db'
import { getPlatformConfig } from '@/lib/platform-config'
import { acceptanceQuote, chatEligibilityOwnershipStatus, getChatFreeEligibility } from '@/lib/chat-eligibility'
import { assertChatPaymentAcceptanceAllowed, createChatPaymentAcceptance } from '@/lib/chat-payment-acceptance'

export const dynamic = 'force-dynamic'
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export async function GET(req: NextRequest) {
  try {
    const session = await getSession()
    if (!session.userId) return reply({ eligible: null, reason: 'login_required', paymentEnabled: false }, 401)
    const agentId = req.nextUrl.searchParams.get('agent_id') ?? ''
    const chatId = req.nextUrl.searchParams.get('chat_id') || undefined
    const key = req.nextUrl.searchParams.get('idempotency_key') || undefined
    if (!uuid(agentId) || (chatId && !uuid(chatId)) || (key && (key.length > 128 || !key.trim()))) {
      return reply({ eligible: null, reason: 'invalid_request', paymentEnabled: false }, 400)
    }
    const db = getDb()
    const user = await db.query.users.findFirst({ where: eq(users.id, session.userId), columns: { bannedAt: true } })
    if (!user || user.bannedAt) return reply({ eligible: null, reason: 'account_unavailable', paymentEnabled: false }, 401)
    const agent = await db.query.agentProfiles.findFirst({ where: and(eq(agentProfiles.id, agentId), eq(agentProfiles.isActive, true)) })
    if (!agent) return reply({ eligible: null, reason: 'agent_not_found', paymentEnabled: false }, 404)
    const chat = chatId ? await db.query.chats.findFirst({ where: eq(chats.id, chatId) }) : null
    if (chatEligibilityOwnershipStatus(chat, session.userId, agentId) === 404) {
      return reply({ eligible: null, reason: 'chat_not_found', paymentEnabled: false }, 404)
    }
    const intent = key ? await createChatPaymentAcceptance().get({ userId: session.userId, idempotencyKey: key }) : null
    if (intent && (intent.agentId !== agentId || (chatId && intent.chatId !== chatId))) {
      return reply({ eligible: null, reason: 'intent_mismatch', paymentEnabled: false }, 409)
    }
    const config = await getPlatformConfig()
    const eligibility = await getChatFreeEligibility({ db, userId: session.userId, agentId, existingChat: Boolean(chat), agentFreeDailyMax: agent.freeDailyMax, agentFreeMessagesPerUser: agent.freeMessagesPerUser })
    const owner = await db.query.users.findFirst({ where: eq(users.id, agent.userId), columns: { wallet: true } })
    const priceMicro = Math.round(Number(agent.priceSubsequent) * 1_000_000)
    const quote = acceptanceQuote({ intent, userId: session.userId, agentId, chatId,
      priceMicro, platformFeeMicro: Math.round(priceMicro * config.platformFeeRate),
      platformRecipient: process.env.PLATFORM_USDC_WALLET ?? process.env.CHAT_PAYMENT_ACCEPTANCE_PLATFORM_WALLET ?? (config.platformFeeRate === 0 ? owner?.wallet ?? '' : ''),
      agentRecipient: owner?.wallet ?? '',
      payer: session.wallet ?? '', authorizationMaxMicro: Math.round(config.chatMaxAuthorizationUsdc * 1_000_000),
    })
    let paymentEnabled = session.cdpVerified === true && quote.payer.toLowerCase() === (session.wallet ?? '').toLowerCase()
    try {
      assertChatPaymentAcceptanceAllowed({ userId: session.userId, agentId, payer: quote.payer, platformRecipient: quote.platformRecipient, agentRecipient: quote.agentRecipient, totalMicro: quote.priceMicro }, process.env, config)
      if (![quote.priceMicro, quote.agentMicro].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(quote.platformFeeMicro) || quote.platformFeeMicro < 0 || quote.remainingBudgetMicro < quote.priceMicro) paymentEnabled = false
      if (intent && [intent.platformStatus, intent.agentStatus].some(status => ['processing', 'settling', 'uncertain'].includes(status))) paymentEnabled = false
    } catch { paymentEnabled = false }
    return reply({ eligible: intent ? false : eligibility.eligible, reason: intent ? 'payment_intent' : eligibility.reason,
      freeMessagesRemaining: eligibility.freeMessagesRemaining, freeMessagesPerUser: Math.min(agent.freeMessagesPerUser, config.agentFreeMessagesPerUserMax),
      ...quote, maxMessageMicro: Math.round(config.chatMaxMessageUsdc * 1_000_000), authorizationMinutes: config.chatAuthorizationMinutes, paymentEnabled, platformStatus: intent?.platformStatus ?? null, agentStatus: intent?.agentStatus ?? null,
      taskId: intent?.taskId ?? null, chatId: intent?.chatId ?? chatId ?? null,
    })
  } catch {
    return reply({ eligible: null, reason: 'eligibility_unavailable', paymentEnabled: false }, 503)
  }
}
