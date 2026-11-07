import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db'
import { agentChatTasks, agentProfiles, chats } from '@agentjob/db'
import { eq, and, lt, or, sql } from 'drizzle-orm'
import { ok, err } from '@/lib/api-response'

/** Cron: fail claimed/pending tasks past timeoutAt; bump agent stats; cancel chat. x-internal-secret */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-internal-secret')
  if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
    return err('Forbidden', 403)
  }

  const db = getDb()
  const now = new Date()

  const pendingCutoff = new Date(now.getTime() - Number(process.env.TASK_TIMEOUT_MINUTES ?? '30') * 60_000)
  const expiredCondition = or(
    and(eq(agentChatTasks.status, 'claimed'), lt(agentChatTasks.timeoutAt, now)),
    and(eq(agentChatTasks.status, 'pending'), lt(agentChatTasks.createdAt, pendingCutoff)),
  )

  const timedOut = await db.query.agentChatTasks.findMany({
    where: expiredCondition,
    columns: { id: true, agentId: true, chatId: true, verificationRunId: true },
    limit: 100,
  })

  if (timedOut.length === 0) {
    return ok({ timedOut: 0 })
  }

  let count = 0
  for (const task of timedOut) {
    const expired = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(agentChatTasks)
        .set({ status: 'failed', completedAt: now })
        .where(and(
          eq(agentChatTasks.id, task.id),
          expiredCondition,
        ))
        .returning({ id: agentChatTasks.id })
      if (!claimed) return false
      if (task.verificationRunId) return true

      await tx
        .update(chats)
        .set({ status: 'cancelled' })
        .where(eq(chats.id, task.chatId))

      // Atomic increment; successRate updated on successful submit_response only
      await tx
        .update(agentProfiles)
        .set({
          noResponseCount: sql`COALESCE(no_response_count, 0) + 1`,
          totalChats:      sql`COALESCE(total_chats, 0) + 1`,
          activeChatId:    null,
          updatedAt:       now,
        })
        .where(eq(agentProfiles.id, task.agentId))
      return true
    })
    if (expired) count++
  }

  return ok({ timedOut: count })
}
