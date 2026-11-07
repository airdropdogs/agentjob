import { NextRequest } from 'next/server'
import { getDb } from '@/lib/db'
import {
  agentProfiles, agentChatTasks, chats,
  messages as messagesTable, agentDailyStats,
} from '@agentjob/db'
import { eq, and, count, sql, or } from 'drizzle-orm'
import { verifyAgentApiKey } from '@/lib/agent-auth'
import { z } from 'zod'
import { readyOutputs, DeliveryError } from '@/lib/provider-deliveries'
import { isRawToolReply } from '@/lib/agent-reply'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const agent = await verifyAgentApiKey(req.headers.get('authorization'))
  if (!agent) {
    return Response.json({ error: 'Invalid or missing API key' }, { status: 401 })
  }

  const { taskId } = await params
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = z.object({ text: z.string().max(100000).default(''), attachmentIds: z.array(z.string().uuid()).max(15).default([]) }).safeParse(body)
  if (!z.string().uuid().safeParse(taskId).success || !parsed.success) return Response.json({ error: 'Invalid response.' }, { status: 400 })
  const text = parsed.data.text.trim()
  const ids = parsed.data.attachmentIds
  if (!text && !ids.length) return Response.json({ error: 'A reply or output file is required.' }, { status: 400 })

  const db = getDb()

  const task = await db.query.agentChatTasks.findFirst({
    where: and(eq(agentChatTasks.id, taskId), eq(agentChatTasks.agentId, agent.id)),
  })
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 })
  }
  if (task.status === 'completed' && task.responseText === text && JSON.stringify(task.responseAttachments.map(a => a.id)) === JSON.stringify(ids)) return Response.json({ submitted: true })
  if (task.status === 'completed' || task.status === 'failed') {
    return Response.json({ error: `Task already ${task.status}` }, { status: 409 })
  }

  if (isRawToolReply(text)) {
    await db.update(agentChatTasks)
      .set({ status: 'failed', completedAt: new Date() })
      .where(and(eq(agentChatTasks.id, taskId), or(eq(agentChatTasks.status, 'pending'), eq(agentChatTasks.status, 'claimed'))))
    return Response.json({ error: 'Agent returned raw tool control output; a final natural-language reply is required' }, { status: 422 })
  }

  let attachments
  try { attachments = await readyOutputs(agent.id, taskId, ids) }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Invalid outputs' }, { status: e instanceof DeliveryError ? e.status : 500 }) }
  const now = new Date()
  const today = now.toISOString().slice(0, 10)

  if (task.verificationRunId) {
    // No consumer history, billing, quota or reputation side effects for platform tests.
    const [saved] = await db.update(agentChatTasks)
      .set({ status: 'completed', responseText: text, responseAttachments: attachments, completedAt: now })
      .where(and(eq(agentChatTasks.id, taskId), eq(agentChatTasks.status, 'claimed'),
        sql`${agentChatTasks.timeoutAt} > now()`, sql`${agentChatTasks.cancelRequestedAt} IS NULL`))
      .returning({ id: agentChatTasks.id })
    return saved ? Response.json({ submitted: true }) : Response.json({ error: 'Request no longer accepting replies' }, { status: 409 })
  }

  const submitted = await db.transaction(async (tx) => {
    const [claimed] = await tx.update(agentChatTasks)
      .set({ status: 'completed', responseText: text, responseAttachments: attachments, completedAt: now })
      .where(and(eq(agentChatTasks.id, taskId), or(eq(agentChatTasks.status, 'pending'), eq(agentChatTasks.status, 'claimed'))))
      .returning({ id: agentChatTasks.id })
    if (!claimed) return false

    await tx.update(chats).set({ status: 'completed' }).where(eq(chats.id, task.chatId))
    await tx.insert(messagesTable)
      .values({ chatId: task.chatId, role: 'assistant', content: text, attachments })


    // Serialize this agent's counters with concurrent replies and timeout cleanup.
    const [p] = await tx.select().from(agentProfiles).where(eq(agentProfiles.id, agent.id)).for('update')
    if (p) {
      const total = (p.totalChats ?? 0) + 1
      const successRate = total > 0 ? (total - (p.noResponseCount ?? 0)) / total : 1

      const [{ value: remaining }] = await tx
        .select({ value: count() })
        .from(agentChatTasks)
        .where(and(eq(agentChatTasks.agentId, agent.id), eq(agentChatTasks.status, 'pending')))
      const maxChats = p.maxConcurrentChats ?? 2
      const newStatus = Number(remaining) >= maxChats ? 'busy' as const : 'online' as const

      await tx.update(agentProfiles)
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

    await tx
      .insert(agentDailyStats)
      .values({ agentId: agent.id, statDate: today, freeUsersCount: 0, totalReplies: 1 })
      .onConflictDoUpdate({
        target: [agentDailyStats.agentId, agentDailyStats.statDate],
        set: { totalReplies: sql`${agentDailyStats.totalReplies} + 1` },
      })

    return true
  })
  if (!submitted) return Response.json({ error: 'Task already completed or failed' }, { status: 409 })

  return Response.json({ submitted: true })
}
