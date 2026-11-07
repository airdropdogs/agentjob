import { and, eq } from 'drizzle-orm'
import { userAgentFreeUsed, agentDailyStats, userDailyFreeStats, users } from '@agentjob/db'
import { FREE_SLOT_WARNING_RATIO } from '@agentjob/shared'
import { getFreeChatPolicy } from './free-chat-policy'
import type { AppDb } from './db'
import { CHAT_PAYMENT_ACCEPTANCE_CAP_MICRO, type AcceptanceIntent } from './chat-payment-acceptance'

export function chatEligibilityOwnershipStatus(chat: { userId: string; agentId: string } | null | undefined, userId: string, agentId: string): 200 | 404 {
  return chat && (chat.userId !== userId || chat.agentId !== agentId) ? 404 : 200
}

export type FreeEligibilityState = {
  existingChat: boolean; userAgentUsedCount: number; freeMessagesPerUser: number; userExists: boolean; banned: boolean
  agentUsed: number; agentLimit: number
  userDailyUsed?: number; userDailyLimit?: number; agentFreeMessagesPerUserMax?: number
}

export function evaluateChatFreeEligibility(state: FreeEligibilityState) {
  const allowance = Math.min(state.freeMessagesPerUser, state.agentFreeMessagesPerUserMax ?? 100)
  const agentLimit = Math.min(state.agentLimit, state.agentFreeMessagesPerUserMax ?? 100)
  const dailyRemaining = Math.max(0, (state.userDailyLimit ?? Number.MAX_SAFE_INTEGER) - (state.userDailyUsed ?? 0))
  const reason = !state.userExists || state.banned ? 'account_unavailable'
    : dailyRemaining === 0 ? 'user_daily_limit'
    : state.userAgentUsedCount >= allowance ? 'agent_free_used'
    : state.agentUsed >= agentLimit ? 'agent_daily_limit'
    : 'free_available'
  const eligible = reason === 'free_available'
  const remaining = agentLimit - state.agentUsed - (eligible ? 1 : 0)
  const slotHint = agentLimit > 0 && remaining / agentLimit <= FREE_SLOT_WARNING_RATIO
    ? 'Only a few slots left today' : undefined
  return { eligible, reason, slotHint, freeMessagesRemaining: Math.max(0, Math.min(allowance - state.userAgentUsedCount, dailyRemaining, agentLimit - state.agentUsed)) }
}

export async function getChatFreeEligibility(input: {
  db: AppDb; userId: string; agentId: string; existingChat: boolean; agentFreeDailyMax: number; agentFreeMessagesPerUser: number
}) {
  const { db, userId, agentId } = input
  const today = new Date().toISOString().slice(0, 10)
  const [used, agentDaily, user, userDaily, policy] = await Promise.all([
    db.select().from(userAgentFreeUsed).where(and(eq(userAgentFreeUsed.userId, userId), eq(userAgentFreeUsed.agentId, agentId))).limit(1),
    db.select().from(agentDailyStats).where(and(eq(agentDailyStats.agentId, agentId), eq(agentDailyStats.statDate, today))).limit(1),
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { bannedAt: true } }),
    db.select().from(userDailyFreeStats).where(and(eq(userDailyFreeStats.userId, userId), eq(userDailyFreeStats.statDate, today))).limit(1),
    getFreeChatPolicy(),
  ])
  return evaluateChatFreeEligibility({
    existingChat: input.existingChat, userAgentUsedCount: used[0]?.usedCount ?? 0, freeMessagesPerUser: input.agentFreeMessagesPerUser, userExists: Boolean(user), banned: Boolean(user?.bannedAt),
    ...policy, userDailyLimit: policy.freeUserDailyLimit, userDailyUsed: userDaily[0]?.freeCount ?? 0,
    agentUsed: agentDaily[0]?.freeUsersCount ?? 0, agentLimit: input.agentFreeDailyMax,
  })
}

export function acceptanceQuote(input: {
  intent: AcceptanceIntent | null; userId: string; agentId: string; chatId?: string
  priceMicro: number; platformFeeMicro: number; platformRecipient: string; agentRecipient: string; payer: string
  reservedMicro: number
}) {
  const { intent } = input
  if (intent && (intent.userId !== input.userId || intent.agentId !== input.agentId || (input.chatId && intent.chatId !== input.chatId))) {
    throw new Error('intent_mismatch')
  }
  const reservedIntentMicro = intent && !intent.taskId ? intent.totalMicro : 0
  return {
    priceMicro: intent?.totalMicro ?? input.priceMicro,
    platformFeeMicro: intent?.platformFeeMicro ?? input.platformFeeMicro,
    agentMicro: intent?.agentMicro ?? input.priceMicro - input.platformFeeMicro,
    platformRecipient: intent?.platformRecipient ?? input.platformRecipient,
    agentRecipient: intent?.agentRecipient ?? input.agentRecipient,
    payer: intent?.payer ?? input.payer,
    remainingBudgetMicro: Math.max(0, CHAT_PAYMENT_ACCEPTANCE_CAP_MICRO - input.reservedMicro) + reservedIntentMicro,
    reservedIntentMicro,
  }
}
