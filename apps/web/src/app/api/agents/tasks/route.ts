import { NextRequest } from 'next/server'
import { providerAttachments } from '@/lib/chat-attachments'
import { getDb } from '@/lib/db'
import { agentProfiles, agentChatTasks } from '@agentjob/db'
import { eq, and, asc } from 'drizzle-orm'
import { verifyAgentApiKey } from '@/lib/agent-auth'
import { setTimeout as sleep } from 'node:timers/promises'

const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MINUTES ?? '30') * 60 * 1_000
const MAX_WAIT_SECS = 60

export async function GET(req: NextRequest) {
  const agent = await verifyAgentApiKey(req.headers.get('authorization'))
  if (!agent) {
    return Response.json({ error: 'Invalid or missing API key' }, { status: 401 })
  }

  const waitParam = req.nextUrl.searchParams.get('wait')
  const wait = Math.min(MAX_WAIT_SECS, Math.max(5, Number(waitParam) || 30))

  const db = getDb()

  await db
    .update(agentProfiles)
    .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
    .where(eq(agentProfiles.id, agent.id))

  const deadline = Date.now() + wait * 1_000
  while (Date.now() < deadline && !req.signal.aborted) {
    const task = await db.query.agentChatTasks.findFirst({
      where: and(
        eq(agentChatTasks.agentId, agent.id),
        eq(agentChatTasks.status, 'pending'),
      ),
      orderBy: [asc(agentChatTasks.createdAt)],
    })

    if (task) {
      const types = (req.headers.get('x-agentjob-attachment-types') ?? '').split(',').map(t => t.trim())
      const latest = task.messages.at(-1) as { attachments?: Array<{ contentType: string }> } | undefined
      if (latest?.attachments?.some(a => !types.includes(a.contentType))) return Response.json({ task: null, reason: 'attachment_connector_required' })
      const deliveryMessages = await providerAttachments(task.messages, task.userId, agent.id, task.chatId, types)
      const now = new Date()
      const [claimed] = await db
        .update(agentChatTasks)
        .set({
          status: 'claimed',
          claimedAt: now,
          timeoutAt: task.verificationRunId ? task.timeoutAt : new Date(now.getTime() + TASK_TIMEOUT_MS),
        })
        .where(and(eq(agentChatTasks.id, task.id), eq(agentChatTasks.status, 'pending')))
        .returning({ id: agentChatTasks.id })

      if (!claimed) {
        await new Promise((r) => setTimeout(r, 100))
        continue
      }

      return Response.json({
        task: {
          id: task.id,
          chat_id: task.chatId,
          messages: deliveryMessages,
          user_id: task.userId,
          is_first_chat: task.isFirstChat,
          amount_usdc: task.amountUsdc,
        },
      })
    }

    // Bound idle database traffic; reconnects still query immediately. The
    // conditional claim above ensures concurrent polls cannot claim one task twice.
    try {
      await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())), undefined, { signal: req.signal })
    } catch (error) {
      if (!req.signal.aborted) throw error
    }
  }

  return Response.json({ task: null })
}
