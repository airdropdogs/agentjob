import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/lib/db'
import { agentProfiles, agentChatTasks, chats, messages } from '@agentjob/db'
import { eq, and, count, sql } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'

const schema = z.object({
  chatId: z.string().uuid(),
  agentId: z.string().uuid(),
  success: z.boolean().default(true),
  /** Assistant text to persist */
  assistantContent: z.string().nullable().optional(),
  userId: z.string().uuid().optional(),
})

/**
 * POST /api/internal/chat-complete — fire-and-forget after stream [DONE].
 * Updates agent stats, adjusts online/busy status, completes chat, may insert assistant message.
 * Auth: x-internal-secret
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-internal-secret')
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return err('Forbidden', 403)
  }

  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return err('Invalid request', 400)

  const { chatId, agentId, success, assistantContent } = parsed.data
  const db = getDb()
  const verification = await db.query.agentChatTasks.findFirst({where:and(eq(agentChatTasks.chatId,chatId),sql`${agentChatTasks.verificationRunId} IS NOT NULL`)})
  if(verification)return ok({updated:false})

  try {
    // Agent row
    const agent = await db.query.agentProfiles.findFirst({
      where: eq(agentProfiles.id, agentId),
    })
    if (!agent) return err('Agent not found', 404)

    const newTotalChats = (agent.totalChats ?? 0) + 1
    const newNoResponseCount = success
      ? (agent.noResponseCount ?? 0)
      : (agent.noResponseCount ?? 0) + 1

    // Rolling success rate
    const successCount = newTotalChats - newNoResponseCount
    const newSuccessRate = newTotalChats > 0 ? successCount / newTotalChats : 1

    // Check remaining pending tasks to decide online vs busy
    const [{ value: pendingCount }] = await db
      .select({ value: count() })
      .from(agentChatTasks)
      .where(and(eq(agentChatTasks.agentId, agentId), eq(agentChatTasks.status, 'pending')))
    const maxChats = agent.maxConcurrentChats ?? 2
    const newStatus = Number(pendingCount) >= maxChats ? 'busy' as const : 'online' as const

    await db
      .update(agentProfiles)
      .set({
        totalChats: newTotalChats,
        noResponseCount: newNoResponseCount,
        successRate: String(newSuccessRate.toFixed(4)),
        activeChatId: null,
        onlineStatus: newStatus,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentProfiles.id, agentId))

    // Chat status
    await db
      .update(chats)
      .set({ status: success ? 'completed' : 'cancelled' })
      .where(eq(chats.id, chatId))

    // Assistant message row
    if (success && assistantContent && assistantContent.trim()) {
      await db.insert(messages).values({
        chatId,
        role: 'assistant',
        content: assistantContent,
      })
    }

    return ok({ updated: true })
  } catch (e) {
    console.error('[chat-complete] Failed to update stats', e)
    return err('Internal error', 500)
  }
}
